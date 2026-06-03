// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1472 Phase B — Wasm-native open-object runtime for `--target standalone`.
 *
 * Open objects (plain object literals, `any`-typed property access) are the
 * single largest standalone-mode failure cluster (26,880 primary rows). In
 * JS-host mode they route through a family of `env::__extern_*` /
 * `env::__object_*` host imports backed by JS WeakMap sidecars; in standalone
 * there is no JS runtime to satisfy those imports. Phase A refuses such code at
 * compile time. Phase B (this module) replaces the sidecars with a pure-WasmGC
 * open-hash-map so dynamic object semantics work with zero host calls.
 *
 * ## Representation
 *
 * ```
 * (type $PropEntry (struct
 *   (field $key   (ref $AnyString))            ;; immutable property key
 *   (field $value (mut anyref))                ;; property value (boxed)
 *   (field $flags (mut i32))))                 ;; writable/enumerable/configurable/tombstone
 *
 * (type $PropMap (array (mut (ref null $PropEntry))))   ;; open-addressing table
 *
 * (type $Object (struct
 *   (field $proto      (mut (ref null $Object)))
 *   (field $props      (mut (ref $PropMap)))
 *   (field $count      (mut i32))              ;; live entries (excl. tombstones)
 *   (field $tombstones (mut i32))              ;; dead entries pending rehash
 *   (field $flags      (mut i32))))            ;; extensible/frozen/sealed bits
 * ```
 *
 * ## Integration strategy (why no per-call-site retargeting)
 *
 * The existing JS-host call sites treat objects as `externref` and look the
 * helper up by name via `ensureLateImport(ctx, "__extern_get", …)` then emit a
 * plain `call funcIdx`. To avoid touching every call site (and the index-shift
 * machinery they rely on), the native helpers registered here keep the **exact
 * same name and externref-based signature** as the host imports:
 *
 *   - `__new_plain_object()                          -> externref`
 *   - `__extern_get(externref obj, externref key)    -> externref`
 *   - `__extern_set(externref obj, externref key, externref value) -> void`
 *
 * Internally a `$Object` struct is wrapped to externref via `extern.convert_any`
 * (a no-op at the engine level, same trick `__box_number` uses) and unwrapped
 * via `any.convert_extern` + `ref.cast $Object`. So `ensureLateImport` can route
 * these names here under `ctx.standalone` exactly like the #1471 boxing helpers
 * (`UNION_NATIVE_HELPER_NAMES`), and the call sites are byte-for-byte unchanged.
 *
 * Keys arrive as `externref` holding a `$NativeString` (standalone auto-enables
 * nativeStrings, so a string literal key is `extern.convert_any(ref
 * $NativeString)`). We `ref.cast $AnyString` + `__str_flatten` to a
 * `$NativeString` for hashing and reuse the existing `__str_equals` for
 * comparison.
 *
 * Closed-shape struct access (the `getFieldEntry` fast path) never reaches this
 * runtime — it emits `struct.get`/`struct.set` directly and never calls
 * `ensureLateImport` for these names.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

/** Initial `$PropMap` capacity. Must be a power of two (mask = cap - 1). */
const INITIAL_CAP = 8;

/** `$PropEntry.$flags` bit layout. */
const FLAG_WRITABLE = 0x01;
const FLAG_ENUMERABLE = 0x02;
const FLAG_CONFIGURABLE = 0x04;
const FLAG_TOMBSTONE = 0x80;
/** Default for a data property created by `o.x = v` — w/e/c all true. */
const FLAG_DEFAULT = FLAG_WRITABLE | FLAG_ENUMERABLE | FLAG_CONFIGURABLE;

/**
 * `$Object.flags` (field 4) object-level integrity bits (#1472 Phase B Blocker
 * A Half 1, landed via PR #1074). Read by the
 * __object_isFrozen/isSealed/isExtensible helpers; set by the freeze/seal SET
 * path (Half 2, not yet landed). On a never-frozen object the field is 0, so
 * isFrozen/isSealed read false and isExtensible reads true.
 */
const OBJ_FLAG_NONEXTENSIBLE = 0x01;
const OBJ_FLAG_SEALED = 0x02;
const OBJ_FLAG_FROZEN = 0x04;

/**
 * Type indices for the open-object runtime structs/arrays, allocated once per
 * module by `ensureObjectRuntime`. Stored on the context so subsequent slices
 * (keys/values/delete/for-in) can reference the same types.
 */
export interface ObjectRuntimeTypes {
  propEntryTypeIdx: number;
  propMapTypeIdx: number;
  objectTypeIdx: number;
  /** `$ObjVec` struct {len: i32, data: (ref (array (mut externref)))} — the
   *  growable externref vector that backs standalone `Object.keys/values/entries`
   *  enumeration results (#1472 Phase B Blocker B). */
  objVecTypeIdx: number;
  /** Backing `(array (mut externref))` for `$ObjVec.data`. */
  objVecArrTypeIdx: number;
}

/**
 * Idempotently register the open-object runtime types + helper functions as
 * defined Wasm functions in `ctx.funcMap` (under the host-import names the call
 * sites already look up). Safe to call repeatedly; only the first call emits.
 *
 * MUST run after `ensureNativeStringHelpers` (it depends on `__str_flatten` /
 * `__str_equals` and the `$NativeString` type indices) — we call it here to
 * guarantee that. Because this path adds only DEFINED functions (no imports),
 * the freshly-allocated func indices sit above every existing function and no
 * index shift is required (same invariant as `addUnionImportsAsNativeFuncs`).
 */
export function ensureObjectRuntime(ctx: CodegenContext): ObjectRuntimeTypes {
  if (ctx.objectRuntimeTypes) return ctx.objectRuntimeTypes;

  // Dependencies: native string helpers (flatten + equals) and the string type
  // indices they populate.
  ensureNativeStringHelpers(ctx);

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;

  // --- 1. Register the three struct/array types. ---
  const propEntryTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$PropEntry",
    fields: [
      { name: "key", type: { kind: "ref", typeIdx: anyStrTypeIdx }, mutable: false },
      { name: "value", type: { kind: "anyref" }, mutable: true },
      { name: "flags", type: { kind: "i32" }, mutable: true },
    ],
  });

  const propMapTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$PropMap",
    element: { kind: "ref_null", typeIdx: propEntryTypeIdx },
    mutable: true,
  });

  const objectTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Object",
    fields: [
      { name: "proto", type: { kind: "ref_null", typeIdx: objectTypeIdx }, mutable: true },
      { name: "props", type: { kind: "ref", typeIdx: propMapTypeIdx }, mutable: true },
      { name: "count", type: { kind: "i32" }, mutable: true },
      { name: "tombstones", type: { kind: "i32" }, mutable: true },
      { name: "flags", type: { kind: "i32" }, mutable: true },
    ],
  });

  // $ObjVec backing array: (array (mut externref)) — holds enumeration results
  // (keys/values/entries) as boxed externrefs. Separate from the closed-shape
  // __vec_externref/__arr_externref the array literal path uses, so this runtime
  // owns its own type and never collides with shifted indices there.
  const objVecArrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$ObjVecArr",
    element: { kind: "externref" },
    mutable: true,
  });

  // $ObjVec struct {len: i32, data: (ref $ObjVecArr)} — a growable externref
  // vector. Wrapped to externref via extern.convert_any so it flows through the
  // existing externref-typed enumeration call sites (Object.keys → __extern_*).
  const objVecTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$ObjVec",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: objVecArrTypeIdx }, mutable: true },
    ],
  });

  const types: ObjectRuntimeTypes = {
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    objVecTypeIdx,
    objVecArrTypeIdx,
  };
  ctx.objectRuntimeTypes = types;

  // Common ValTypes.
  const objRef: ValType = { kind: "ref", typeIdx: objectTypeIdx };
  const objRefNull: ValType = { kind: "ref_null", typeIdx: objectTypeIdx };
  const propMapRef: ValType = { kind: "ref", typeIdx: propMapTypeIdx };
  const entryRefNull: ValType = { kind: "ref_null", typeIdx: propEntryTypeIdx };
  const anyStrRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const nativeStrRef: ValType = { kind: "ref", typeIdx: nativeStrTypeIdx };
  const objVecRef: ValType = { kind: "ref", typeIdx: objVecTypeIdx };
  const objVecArrRef: ValType = { kind: "ref", typeIdx: objVecArrTypeIdx };

  // Helper: register a defined function, return its funcIdx.
  const registerNative = (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ): number => {
    const typeIdx = addFuncType(ctx, paramTypes, resultTypes);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(name, funcIdx);
    ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false });
    return funcIdx;
  };

  // Look up an already-emitted native string helper.
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals")!;

  // ── $__obj_hash(externref key) -> i32 ────────────────────────────────────
  //
  // FNV-1a over the UTF-16 code units of the flattened string. The key is an
  // externref holding a $NativeString/$AnyString; convert + cast + flatten,
  // then read len/off/data and fold. Returns a non-negative i32 hash.
  //
  // locals: 1=str(ref $NativeString) 2=data(ref $strData) 3=len 4=off 5=i 6=h
  {
    const FNV_OFFSET = 0x811c9dc5 | 0;
    const FNV_PRIME = 0x01000193;
    const body: Instr[] = [
      // str = flatten(cast<$AnyString>(any.convert_extern(key)))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.tee", index: 1 },
      // len = str.len ; off = str.off ; data = str.data
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },
      // h = FNV_OFFSET ; i = 0
      { op: "i32.const", value: FNV_OFFSET },
      { op: "local.set", index: 6 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // h = (h ^ data[off + i]) * FNV_PRIME
              { op: "local.get", index: 6 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.xor" },
              { op: "i32.const", value: FNV_PRIME },
              { op: "i32.mul" },
              { op: "local.set", index: 6 },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return h & 0x7fffffff  (non-negative; masking happens at call sites too)
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 0x7fffffff },
      { op: "i32.and" },
    ];
    registerNative(
      "__obj_hash",
      [{ kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "str", type: nativeStrRef },
        { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "off", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "h", type: { kind: "i32" } },
      ],
      body,
    );
  }
  const objHashIdx = ctx.funcMap.get("__obj_hash")!;

  // ── __new_plain_object() -> externref ────────────────────────────────────
  //
  // struct.new $Object { proto: null, props: new $PropMap[INITIAL_CAP], count:
  // 0, tombstones: 0, flags: 0 }, then extern.convert_any.
  {
    const body: Instr[] = [
      { op: "ref.null", typeIdx: objectTypeIdx }, // proto
      { op: "i32.const", value: INITIAL_CAP }, // props: array.new_default count
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "i32.const", value: 0 }, // count
      { op: "i32.const", value: 0 }, // tombstones
      { op: "i32.const", value: 0 }, // flags
      { op: "struct.new", typeIdx: objectTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative("__new_plain_object", [], [{ kind: "externref" }], [], body);
  }

  // ── $__obj_find(ref $Object, externref key) -> ref null $PropEntry ────────
  //
  // Linear-probing lookup in the object's OWN props table (no proto walk).
  // Returns the matching live entry, or null if absent. Tombstoned entries
  // (FLAG_TOMBSTONE set) are skipped but do not terminate the probe (they are
  // "deleted but occupied" slots in open addressing).
  //
  // params: 0=o(ref $Object) 1=key(externref)
  // locals: 2=arr(ref $PropMap) 3=cap 4=mask 5=i 6=e(ref null $PropEntry) 7=fkey(ref $NativeString)
  {
    const body: Instr[] = [
      // fkey = flatten(cast<$AnyString>(any.convert_extern(key)))
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.set", index: 7 },
      // arr = o.props ; cap = arr.len ; mask = cap - 1
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 2 },
      { op: "array.len" },
      { op: "local.tee", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: 4 },
      // i = hash(key) & mask
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objHashIdx },
      { op: "local.get", index: 4 },
      { op: "i32.and" },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // e = arr[i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              // if e == null → key absent → return null
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "ref.null", typeIdx: propEntryTypeIdx }, { op: "return" }],
              },
              // if !(e.flags & TOMBSTONE) && str_equals(flatten(e.key), fkey) → return e
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: FLAG_TOMBSTONE },
              { op: "i32.and" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // flatten(e.key)
                  { op: "local.get", index: 6 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "call", funcIdx: strFlattenIdx },
                  { op: "local.get", index: 7 },
                  { op: "call", funcIdx: strEqualsIdx },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "local.get", index: 6 }, { op: "return" }],
                  },
                ],
              },
              // i = (i + 1) & mask ; loop
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: 4 },
              { op: "i32.and" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "ref.null", typeIdx: propEntryTypeIdx },
    ];
    registerNative(
      "__obj_find",
      [objRef, { kind: "externref" }],
      [entryRefNull],
      [
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "mask", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "fkey", type: nativeStrRef },
      ],
      body,
    );
  }
  const objFindIdx = ctx.funcMap.get("__obj_find")!;

  // ── __extern_get(externref obj, externref key) -> externref ──────────────
  //
  // Unwrap obj to $Object (return null on non-object), walk the own-property
  // entry then the prototype chain. Property values are stored as anyref;
  // convert back to externref for the result.
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=o(ref null $Object) 3=e(ref null $PropEntry) 4=any(anyref)
  {
    const body: Instr[] = [
      // any = any.convert_extern(obj)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      // if !ref.test $Object → not one of our objects → return null
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 4 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      // proto-walk loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if o == null break
              { op: "local.get", index: 2 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // e = __obj_find(o, key)
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: objFindIdx },
              { op: "local.tee", index: 3 },
              // if e != null → return extern.convert_any(e.value)
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  { op: "extern.convert_any" },
                  { op: "return" },
                ],
              },
              // o = o.proto ; loop
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found anywhere → null
      { op: "ref.null.extern" },
    ];
    registerNative(
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
        { name: "any", type: { kind: "anyref" } },
      ],
      body,
    );
  }

  // ── $__obj_insert(ref $Object, externref key, anyref value, i32 flags) ────
  //
  // Insert-or-update on the OWN table. Caller is responsible for growing the
  // table BEFORE calling when the load factor is exceeded (see __extern_set).
  // On update of a LIVE entry with the same key, overwrites value + flags.
  //
  // params: 0=o(ref $Object) 1=key(externref) 2=value(anyref) 3=flags
  // locals: 4=arr(ref $PropMap) 5=cap 6=mask 7=i 8=e(ref null $PropEntry) 9=fkey(ref $NativeString) 10=keyStr(ref $AnyString)
  {
    const body: Instr[] = [
      // keyStr = cast<$AnyString>(any.convert_extern(key)) ; fkey = flatten(keyStr)
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
      { op: "local.tee", index: 10 },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.set", index: 9 },
      // arr = o.props ; cap = arr.len ; mask = cap - 1
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 4 },
      { op: "array.len" },
      { op: "local.tee", index: 5 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: 6 },
      // i = hash(key) & mask
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objHashIdx },
      { op: "local.get", index: 6 },
      { op: "i32.and" },
      { op: "local.set", index: 7 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // e = arr[i]
              { op: "local.get", index: 4 },
              { op: "local.get", index: 7 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 8 },
              // empty slot → create new entry here, UNLESS the object is
              // non-extensible (#1472 Phase B Blocker A Half 2). A
              // sealed/preventExtensions/frozen object refuses NEW keys per ES
              // §10.4.7 [[DefineOwnProperty]] extensibility check — sloppy no-op
              // (strict throw deferred to #1473). Updates of existing keys are
              // unaffected (they take the update-in-place branch below). A
              // frozen object never reaches __obj_insert via __extern_set (the
              // FROZEN gate there returns first), but __obj_insert is also
              // called during __obj_grow rehash — where the table is rebuilt
              // from existing live entries, all of which take the empty-slot
              // branch. We must NOT refuse those, so the gate is keyed on the
              // OBJECT's NON_EXTENSIBLE bit, which during a grow only matters
              // when a non-extensible object grows (it can't — no new key was
              // accepted, so load never rises to force a grow). Safe.
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // if o.flags & NON_EXTENSIBLE → refuse new key (return)
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
                  { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
                  { op: "i32.and" },
                  { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
                  // arr[i] = struct.new $PropEntry { keyStr, value, flags }
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 7 },
                  { op: "local.get", index: 10 },
                  { op: "local.get", index: 2 },
                  { op: "local.get", index: 3 },
                  { op: "struct.new", typeIdx: propEntryTypeIdx },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                  // o.count++
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
                  { op: "return" },
                ],
              },
              // occupied + LIVE + key matches → update in place
              // str_equals(flatten(e.key), fkey)
              { op: "local.get", index: 8 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.get", index: 9 },
              { op: "call", funcIdx: strEqualsIdx },
              // AND not a tombstone
              { op: "local.get", index: 8 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: FLAG_TOMBSTONE },
              { op: "i32.and" },
              { op: "i32.eqz" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // e.value = value ; e.flags = flags ; return (update in place)
                  { op: "local.get", index: 8 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 2 },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 8 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 3 },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "return" },
                ],
              },
              // collision → i = (i + 1) & mask ; loop
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: 6 },
              { op: "i32.and" },
              { op: "local.set", index: 7 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];
    registerNative(
      "__obj_insert",
      [objRef, { kind: "externref" }, { kind: "anyref" }, { kind: "i32" }],
      [],
      [
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "mask", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "fkey", type: nativeStrRef },
        { name: "keyStr", type: anyStrRef },
      ],
      body,
    );
  }
  const objInsertIdx = ctx.funcMap.get("__obj_insert")!;

  // ── $__obj_grow(ref $Object) -> void ─────────────────────────────────────
  //
  // Double the capacity and rehash live (non-tombstone) entries into a fresh
  // table. Resets tombstones to 0 and replays entries through __obj_insert
  // against the NEW table (count reset to 0 first so inserts re-accumulate it).
  //
  // params: 0=o(ref $Object)
  // locals: 1=old(ref $PropMap) 2=newCap 3=i 4=oldLen 5=e(ref null $PropEntry)
  {
    const body: Instr[] = [
      // old = o.props ; oldLen = old.len ; newCap = oldLen * 2
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 1 },
      { op: "array.len" },
      { op: "local.tee", index: 4 },
      { op: "i32.const", value: 2 },
      { op: "i32.mul" },
      { op: "local.set", index: 2 },
      // o.props = new $PropMap[newCap] ; o.count = 0 ; o.tombstones = 0
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 3 },
      // for i in 0..oldLen: replay live entries
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // e = old[i]
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 5 },
              // if e != null && !(e.flags & TOMBSTONE): re-insert
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 5 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // __obj_insert(o, extern.convert_any(e.key), e.value, e.flags)
                      { op: "local.get", index: 0 },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                      { op: "extern.convert_any" },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                      { op: "call", funcIdx: objInsertIdx },
                    ],
                  },
                ],
              },
              // i++
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];
    registerNative(
      "__obj_grow",
      [objRef],
      [],
      [
        { name: "old", type: propMapRef },
        { name: "newCap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "oldLen", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }
  const objGrowIdx = ctx.funcMap.get("__obj_grow")!;

  // ── __extern_set(externref obj, externref key, externref value) -> void ──
  //
  // Unwrap obj to $Object (no-op on non-object — matches host leniency), grow
  // if the load factor is too high, then insert/update with default data-prop
  // flags. Value is stored as anyref via any.convert_extern.
  //
  // params: 0=obj 1=key 2=value
  // locals: 3=o(ref null $Object) 4=cap 5=load 6=any(anyref)
  {
    const body: Instr[] = [
      // any = any.convert_extern(obj)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 6 },
      // if !ref.test $Object → silently no-op (host import is lenient too)
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "return" }],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 6 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 3 },
      // #1472 Phase B Blocker A Half 2 — FROZEN write gate. A frozen object
      // refuses ALL data writes (update AND new key) per ES §10.4.7 / the
      // [[Set]] invariant on non-writable own data properties. Sloppy-mode
      // no-op here (strict-mode TypeError throw is deferred to the error
      // machinery slice, #1473). Sealed/non-extensible objects still allow
      // updates of existing keys — that new-key refusal lives in __obj_insert's
      // empty-slot branch (gated on NON_EXTENSIBLE), so it is NOT gated here.
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_FROZEN },
      { op: "i32.and" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      // load = o.count + o.tombstones ; cap = o.props.len
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 5 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      // if (load + 1) * 10 >= cap * 7 → grow  (load factor 0.7)
      { op: "local.get", index: 5 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.const", value: 10 },
      { op: "i32.mul" },
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 7 },
      { op: "i32.mul" },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 3 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
      },
      // __obj_insert(o, key, any.convert_extern(value), FLAG_DEFAULT)
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "i32.const", value: FLAG_DEFAULT },
      { op: "call", funcIdx: objInsertIdx },
    ];
    registerNative(
      "__extern_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
      [
        { name: "o", type: objRefNull },
        { name: "cap", type: { kind: "i32" } },
        { name: "load", type: { kind: "i32" } },
        { name: "any", type: { kind: "anyref" } },
      ],
      body,
    );
  }

  // ── __delete_property(externref obj, externref key) -> i32 ───────────────
  //
  // ES §13.5.1 delete operator on an own data property. Finds the live entry;
  // if present, marks it tombstoned (FLAG_TOMBSTONE), nulls its value (drop the
  // reference for GC), decrements count, increments tombstones, returns 1. A
  // configurable check could refuse non-configurable props, but data props
  // created via __extern_set are always configurable (FLAG_DEFAULT), so delete
  // always succeeds — returns 1 even when the key is absent (matches the host
  // import, which returns true for missing own props per spec step 5).
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=any(anyref) 3=o(ref null $Object) 4=e(ref null $PropEntry)
  {
    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !ref.test $Object → return 1 (no-op success)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; e = __obj_find(o, key)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 3 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 4 },
      // if e == null → property absent → return 1 (delete of missing key succeeds)
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
      // e.flags |= TOMBSTONE
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: FLAG_TOMBSTONE },
      { op: "i32.or" },
      { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      // o.count-- ; o.tombstones++
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 3 },
      // return 1
      { op: "i32.const", value: 1 },
    ];
    registerNative(
      "__delete_property",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // #1472 Phase B Blocker B — native $ObjVec build/iterate foundation.
  //
  // A growable externref vector that backs standalone enumeration results
  // (Object.keys/values/entries). It is wrapped to externref via
  // extern.convert_any so the result flows unchanged through the existing
  // externref-typed enumeration call sites, where the consumer reads it back
  // via __extern_length + __extern_get_idx. Those two helpers gain a
  // $ObjVec-aware native path here so the round-trip is fully host-free.
  //
  // Insert/append uses doubling growth; INITIAL_CAP keeps small objects cheap.
  // ════════════════════════════════════════════════════════════════════════

  // ── __objvec_new() -> externref ─────────────────────────────────────────
  // struct.new $ObjVec { len: 0, data: new $ObjVecArr[INITIAL_CAP] }, wrapped.
  {
    const body: Instr[] = [
      { op: "i32.const", value: 0 }, // len
      { op: "i32.const", value: INITIAL_CAP }, // data: array.new_default count
      { op: "array.new_default", typeIdx: objVecArrTypeIdx },
      { op: "struct.new", typeIdx: objVecTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative("__objvec_new", [], [{ kind: "externref" }], [], body);
  }
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;

  // ── __objvec_push(externref vec, externref elem) -> void ─────────────────
  //
  // Append elem to the wrapped $ObjVec, doubling the backing array when full.
  // No-op (silently) if vec is not a $ObjVec — keeps the helper total.
  //
  // params: 0=vec(externref) 1=elem(externref)
  // locals: 2=any(anyref) 3=v(ref null $ObjVec) 4=arr(ref null $ObjVecArr)
  //         5=len 6=cap 7=narr(ref null $ObjVecArr) 8=i
  {
    const body: Instr[] = [
      // any = any.convert_extern(vec); if !$ObjVec → return
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      // v = cast<$ObjVec>(any)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "local.set", index: 3 },
      // arr = v.data ; len = v.len ; cap = arr.len
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 4 },
      { op: "array.len" },
      { op: "local.set", index: 6 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 5 },
      // if len >= cap → grow: narr = new[cap*2]; copy 0..len; v.data = narr; arr = narr
      { op: "local.get", index: 5 },
      { op: "local.get", index: 6 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // narr = array.new_default(cap*2)  (cap is always >=1)
          { op: "local.get", index: 6 },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "array.new_default", typeIdx: objVecArrTypeIdx },
          { op: "local.set", index: 7 },
          // i = 0; while i < len: narr[i] = arr[i]; i++
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 8 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 5 },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // narr[i] = arr[i]
                  { op: "local.get", index: 7 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 8 },
                  { op: "array.get", typeIdx: objVecArrTypeIdx },
                  { op: "array.set", typeIdx: objVecArrTypeIdx },
                  // i++
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 8 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          // v.data = narr ; arr = narr
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 7 },
          { op: "ref.as_non_null" },
          { op: "struct.set", typeIdx: objVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 7 },
          { op: "local.set", index: 4 },
        ],
      },
      // arr[len] = elem ; v.len = len + 1
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 5 },
      { op: "local.get", index: 1 },
      { op: "array.set", typeIdx: objVecArrTypeIdx },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 5 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    ];
    registerNative(
      "__objvec_push",
      [{ kind: "externref" }, { kind: "externref" }],
      [],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "v", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
        { name: "arr", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "cap", type: { kind: "i32" } },
        { name: "narr", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
    );
  }
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;

  // ── __object_keys(externref obj) -> externref ────────────────────────────
  //
  // ES §20.1.2.18 — own enumerable string keys, insertion-order-ish (we walk
  // the open-hash table slots; order is hash order, acceptable for the
  // standalone open-object path which has no host array to preserve order).
  // Build a fresh $ObjVec, push each LIVE (non-tombstone) entry's key. Non
  // $Object receivers return an empty $ObjVec (host returns [] for those that
  // reach here; ToObject-throw on null/undefined is handled at the call site).
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ref $PropMap) 4=cap 5=i
  //         6=e(ref null $PropEntry) 7=vec(externref)
  {
    const body: Instr[] = [
      // vec = __objvec_new()
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      // any = any.convert_extern(obj); if !$Object → return empty vec
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 7 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; arr = o.props ; cap = arr.len
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= cap break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // e = arr[i]
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              // if e != null && !(e.flags & TOMBSTONE) && (e.flags & ENUMERABLE):
              //   __objvec_push(vec, extern.convert_any(e.key))
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 6 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" }, // not tombstone
                  { op: "local.get", index: 6 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_ENUMERABLE },
                  { op: "i32.and" }, // enumerable bit
                  { op: "i32.and" }, // (not tombstone) && enumerable
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 6 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                      { op: "extern.convert_any" },
                      { op: "call", funcIdx: objVecPushIdx },
                    ],
                  },
                ],
              },
              // i++ ; loop
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return vec
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_keys",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __extern_length(externref v) -> f64 ──────────────────────────────────
  //
  // Standalone numeric "length" for an enumeration result. Recognises a wrapped
  // $ObjVec and returns its f64 len; any other value returns 0 (matches the
  // host import's null/non-array fallback). This is what the array-iteration
  // consumers (buildVecFromExternref, array-methods length loops) read.
  //
  // params: 0=v(externref) ; locals: 1=any(anyref)
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objVecTypeIdx },
          { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
          { op: "f64.convert_i32_s" },
        ],
        else: [{ op: "f64.const", value: 0 }],
      },
    ];
    registerNative(
      "__extern_length",
      [{ kind: "externref" }],
      [{ kind: "f64" }],
      [{ name: "any", type: { kind: "anyref" } }],
      body,
    );
  }

  // ── __extern_get_idx(externref v, f64 idx) -> externref ───────────────────
  //
  // Standalone indexed read. Recognises a wrapped $ObjVec and returns
  // data[i32(idx)] when 0 <= idx < len; otherwise null. Any non-$ObjVec value
  // returns null (matches the host import's null/undefined fallback).
  //
  // params: 0=v(externref) 1=idx(f64) ; locals: 2=any(anyref) 3=vec(ref null $ObjVec) 4=i
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // vec = cast<$ObjVec>(any) ; i = i32(idx)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.tee", index: 4 },
      // if i < 0 || i >= vec.len → null
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      { op: "local.get", index: 4 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // return vec.data[i]
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: 4 },
      { op: "array.get", typeIdx: objVecArrTypeIdx },
    ];
    registerNative(
      "__extern_get_idx",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "vec", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
    );
  }
  // ── Object integrity predicates (#1472 Phase B Blocker A Half 1, PR #1074) ─
  //
  // __object_isFrozen / __object_isSealed / __object_isExtensible read the
  // object-level `$Object.flags` (field 4). On a never-frozen `$Object` the
  // flags field is 0 → isFrozen/isSealed read false, isExtensible reads true.
  // ES §20.5.2.13/14: isFrozen/isSealed on a NON-object return TRUE; §20.5.2.12:
  // isExtensible on a non-object returns FALSE. (Merged from main; preserved
  // here through the Blocker B merge so the standalone predicates remain native.)
  const emitIntegrityPredicate = (name: string, flagBit: number, invert: boolean, nonObjResult: number): void => {
    const testExpr: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: flagBit },
      { op: "i32.and" },
    ];
    if (invert) {
      testExpr.push({ op: "i32.eqz" });
    } else {
      testExpr.push({ op: "i32.const", value: 0 }, { op: "i32.ne" });
    }
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: testExpr,
        else: [{ op: "i32.const", value: nonObjResult }],
      },
    ];
    registerNative(name, [{ kind: "externref" }], [{ kind: "i32" }], [{ name: "any", type: { kind: "anyref" } }], body);
  };
  emitIntegrityPredicate("__object_isFrozen", OBJ_FLAG_FROZEN, false, 1);
  emitIntegrityPredicate("__object_isSealed", OBJ_FLAG_SEALED, false, 1);
  emitIntegrityPredicate("__object_isExtensible", OBJ_FLAG_NONEXTENSIBLE, true, 0);

  // ── Object integrity SET path (#1472 Phase B Blocker A Half 2) ────────────
  //
  // __object_preventExtensions / __object_seal / __object_freeze set the
  // object-level `$Object.flags` (field 4) integrity bits and return the
  // ORIGINAL externref (identity preserved — these return their argument per
  // ES §20.5.2.{5,18,6}). freeze ⊃ seal ⊃ preventExtensions, so each sets a
  // cumulative bit-mask:
  //   preventExtensions → NONEXTENSIBLE
  //   seal              → NONEXTENSIBLE | SEALED
  //   freeze            → NONEXTENSIBLE | SEALED | FROZEN
  // The write gates in __extern_set (FROZEN → refuse all) and __obj_insert
  // empty-slot (NONEXTENSIBLE → refuse new key) read these bits to enforce
  // immutability. Non-$Object receiver: returned unchanged (primitives are
  // already non-extensible; the predicate readers handle their query side).
  //
  // params: 0=obj(externref) ; locals: 1=any(anyref) 2=o(ref null $Object)
  const emitSetFlags = (name: string, bits: number): void => {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // o = cast<$Object>(any) ; o.flags |= bits
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.tee", index: 2 },
          { op: "local.get", index: 2 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: bits },
          { op: "i32.or" },
          { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 4 },
        ],
      },
      // return the original externref unchanged (identity preserved)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      name,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
      ],
      body,
    );
  };
  emitSetFlags("__object_preventExtensions", OBJ_FLAG_NONEXTENSIBLE);
  emitSetFlags("__object_seal", OBJ_FLAG_NONEXTENSIBLE | OBJ_FLAG_SEALED);
  emitSetFlags("__object_freeze", OBJ_FLAG_NONEXTENSIBLE | OBJ_FLAG_SEALED | OBJ_FLAG_FROZEN);

  // Silence "declared but never used" for ValType aliases reserved for the
  // values/entries/assign slices that stack on this foundation.
  void objVecRef;
  void objVecArrRef;
  void nativeStrRef;

  return types;
}

/**
 * Names of the object-runtime host imports that `ensureObjectRuntime` provides
 * Wasm-native implementations for. `ensureLateImport` routes these here under
 * `ctx.standalone` (mirrors `UNION_NATIVE_HELPER_NAMES` for the #1471 boxing
 * helpers) so existing call sites resolve to the native func with no per-site
 * change. Internal helpers (`__obj_hash`, `__obj_find`, `__obj_insert`,
 * `__obj_grow`) are NOT in this set — they are never requested via
 * `ensureLateImport`.
 */
export const OBJECT_RUNTIME_HELPER_NAMES: ReadonlySet<string> = new Set([
  "__new_plain_object",
  "__extern_get",
  "__extern_set",
  "__delete_property",
  // #1472 Phase B Blocker B — native $ObjVec-backed enumeration + indexed read.
  "__object_keys",
  "__extern_length",
  "__extern_get_idx",
  // #1472 Phase B Blocker A Half 1 (PR #1074) — object integrity predicates.
  "__object_isFrozen",
  "__object_isSealed",
  "__object_isExtensible",
  // #1472 Phase B Blocker A Half 2 — object integrity SET path.
  "__object_preventExtensions",
  "__object_seal",
  "__object_freeze",
]);
