// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3177) Integer-indexed exotic-object MOP arms for `$__ta_dyn_view`
 * receivers in the STANDALONE dynamic-object runtime (ECMA-262 §10.4.5).
 *
 * Every standalone MOP native (`__extern_get` / `__extern_set` /
 * `__extern_has` / `__reflect_set` / `__delete_property` / `__object_keys` /
 * `__extern_get_idx` / `__extern_has_idx`) gated exclusively on
 * `ref.test $Object`, so a dynamically-constructed TypedArray view — the shape
 * every `testWithTypedArrayConstructors` harness closure produces — fell
 * through: get→undefined, set→silent no-op, has→false, delete→true,
 * keys→`[]`. This module adds finalize-time, `ref.test $__ta_dyn_view`-guarded
 * arms PREPENDED at body index 0 (the `fillDynamicForinVecArms` / #3183
 * discipline: prepend the arm, append locals, never renumber existing ones,
 * fall through untouched for every non-view receiver). The dyn-view arm must
 * sit IN FRONT of the generic `$__vec_base` arms because `$__ta_dyn_view`
 * subtypes `$__vec_base` (#3057) but needs §10.4.5 semantics, not plain-vec
 * semantics.
 *
 * Spec anchors:
 *  - CanonicalNumericIndexString (§7.1.21): P is canonical iff
 *    P == ToString(ToNumber(P)) or P == "-0". Implemented as a
 *    `__str_to_number` → `number_toString` round-trip + a "-0" literal
 *    compare — an exact encoding of the definition.
 *  - IsValidIntegerIndex (§10.4.5.14): integral, not -0, 0 ≤ i < len, buffer
 *    not detached. Detach is the backing byte-vec's `length` forced to −1
 *    ($DETACHBUFFER), which `pushTaDynViewInBoundsLen` already floors to an
 *    effective length of 0 — so OOB covers detached for free.
 *  - [[Get]]/[[Set]]/[[HasProperty]]/[[Delete]] (§10.4.5.5–8): a CANONICAL
 *    numeric key always takes element semantics (valid → element, invalid →
 *    undefined/true-noop/false/true respectively) and NEVER falls through to
 *    ordinary lookup; a non-canonical key takes ordinary semantics (named
 *    intrinsic props here; expando properties are a follow-on).
 *
 * Kept OUT of object-runtime.ts / dataview-native.ts deliberately — both are
 * at their LOC budget; the shared byte codec is imported from
 * dataview-native (`emitDynDecodeDispatch`/`emitDynEncodeDispatch`/
 * `pushElemSizeForKind`/`pushTaDynViewInBoundsLen`, exported for this).
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  emitDynDecodeDispatch,
  emitDynEncodeDispatch,
  i32ByteVec,
  pushElemSizeForKind,
  pushTaDynViewInBoundsLen,
} from "./dataview-native.js";
import { addFuncType, TA_CTOR_KINDS } from "./registry/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
// (#3177 slice 3) per-kind `<View>.prototype` identity — the SAME $NativeProto
// glue singleton a static `<View>.prototype` value read yields.
import { ensureTypedArrayViewNativeProtoGlue } from "./array-object-proto.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";

/** Fresh synthetic FunctionContext for a native helper (the #2872 pattern). */
function makeFctx(name: string, params: { name: string; type: ValType }[], returnType: ValType): FunctionContext {
  return {
    name,
    params,
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  } as unknown as FunctionContext;
}

/**
 * Emit the §10.4.5.14 IsValidIntegerIndex check over `idxF64Local` against
 * `lenLocal`, leaving an i32 (1 = valid) on the stack. Also truncates the
 * index into `idxI32Local` for the caller's element math.
 * valid ⇔ integral (idx == trunc(idx); NaN fails) ∧ not -0 ∧ (u32)i < len
 * (negative → huge unsigned → fails; ±Infinity passes integral but clamps to
 * INT32_MAX/MIN and fails bounds; detached buffers already read len 0).
 */
function pushIsValidIntegerIndex(
  fctx: FunctionContext,
  idxF64Local: number,
  idxI32Local: number,
  lenLocal: number,
): void {
  // i = trunc_sat(idx)
  fctx.body.push({ op: "local.get", index: idxF64Local });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: idxI32Local });
  // integral: idx == trunc(idx)
  fctx.body.push({ op: "local.get", index: idxF64Local });
  fctx.body.push({ op: "local.get", index: idxF64Local });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "f64.eq" });
  // not -0: !(bits(idx) == bits(-0)) — sign bit set with zero value
  fctx.body.push({ op: "local.get", index: idxF64Local });
  fctx.body.push({ op: "i64.reinterpret_f64" });
  fctx.body.push({ op: "i64.const", value: -9223372036854775808n }); // 0x8000_0000_0000_0000 = -0 bits
  fctx.body.push({ op: "i64.eq" });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "i32.and" });
  // bounds: (u32)i < len
  fctx.body.push({ op: "local.get", index: idxI32Local });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({ op: "i32.and" });
}

/** Shared preamble: cast recv (param 0, externref) → dv/kind/es/len locals. */
function pushDynPreamble(
  ctx: CodegenContext,
  fctx: FunctionContext,
  dynIdx: number,
  dvLocal: number,
  kindLocal: number,
  esLocal: number,
  lenLocal: number,
): void {
  fctx.body.push({ op: "local.get", index: 0 });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: dynIdx });
  fctx.body.push({ op: "local.set", index: dvLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 }); // kind
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  pushTaDynViewInBoundsLen(ctx, fctx, dvLocal, esLocal);
  fctx.body.push({ op: "local.set", index: lenLocal });
}

/** arr = dv.buf.data ; off = dv.byteOffset + i*es ; le = 1. */
function pushElemAddr(
  ctx: CodegenContext,
  fctx: FunctionContext,
  dynIdx: number,
  vecTypeIdx: number,
  dvLocal: number,
  idxI32Local: number,
  esLocal: number,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
): void {
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 }); // buf
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // data
  fctx.body.push({ op: "local.set", index: arrLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 }); // byteOffset
  fctx.body.push({ op: "local.get", index: idxI32Local });
  fctx.body.push({ op: "local.get", index: esLocal });
  fctx.body.push({ op: "i32.mul" });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: offLocal });
  fctx.body.push({ op: "i32.const", value: 1 }); // little-endian
  fctx.body.push({ op: "local.set", index: leLocal });
}

/**
 * Ensure the three element-semantics natives exist (idempotent, funcMap-keyed):
 *   __ta_dyn_get_elem(externref recv, f64 idx) -> externref
 *   __ta_dyn_set_elem(externref recv, f64 idx, externref v) -> i32 (always 1)
 *   __ta_dyn_has_idx (externref recv, f64 idx) -> i32
 * Caller guarantees recv IS a $__ta_dyn_view (ref.test at the arm). All are
 * DEFINED functions — no import, no funcIdx shift.
 */
export function ensureTaDynMopElemHelpers(
  ctx: CodegenContext,
): { getElem: number; setElem: number; hasIdx: number } | undefined {
  const dynIdx = ctx.taDynViewTypeIdx;
  if (dynIdx < 0) return undefined;
  const cached = ctx.funcMap.get("__ta_dyn_get_elem");
  if (cached !== undefined) {
    return {
      getElem: cached,
      setElem: ctx.funcMap.get("__ta_dyn_set_elem")!,
      hasIdx: ctx.funcMap.get("__ta_dyn_has_idx")!,
    };
  }
  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  const boxNumIdx = ctx.funcMap.get("__box_number");
  if (boxNumIdx === undefined) return undefined;
  const extern: ValType = { kind: "externref" };
  const f64: ValType = { kind: "f64" };
  const i32: ValType = { kind: "i32" };

  // ── __ta_dyn_get_elem ──
  const getTypeIdx = addFuncType(ctx, [extern, f64], [extern]);
  const getFuncIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__ta_dyn_get_elem", getFuncIdx);
  {
    const fctx = makeFctx(
      "__ta_dyn_get_elem",
      [
        { name: "recv", type: extern },
        { name: "idx", type: f64 },
      ],
      extern,
    );
    const dv = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
    const kind = allocLocal(fctx, "kind", i32);
    const es = allocLocal(fctx, "es", i32);
    const len = allocLocal(fctx, "len", i32);
    const i = allocLocal(fctx, "i", i32);
    const arr = allocLocal(fctx, "arr", { kind: "ref", typeIdx: arrTypeIdx });
    const off = allocLocal(fctx, "off", i32);
    const le = allocLocal(fctx, "le", i32);
    pushDynPreamble(ctx, fctx, dynIdx, dv, kind, es, len);
    pushIsValidIntegerIndex(fctx, 1, i, len);
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr]), { op: "return" }],
    });
    pushElemAddr(ctx, fctx, dynIdx, vecTypeIdx, dv, i, es, arr, off, le);
    fctx.body.push(...emitDynDecodeDispatch(ctx, fctx, kind, arr, off, le, arrTypeIdx));
    fctx.body.push({ op: "call", funcIdx: boxNumIdx });
    pushDefinedFunc(ctx, getFuncIdx, {
      name: "__ta_dyn_get_elem",
      typeIdx: getTypeIdx,
      locals: fctx.locals,
      body: fctx.body,
      exported: false,
    });
  }

  // ── __ta_dyn_set_elem ──
  // §10.4.5.16 IntegerIndexedElementSet: ToNumber(v) FIRST (observable — may
  // run valueOf / throw), THEN validity; an invalid index is a silent no-op.
  // [[Set]] on a canonical index always reports true (ES2021+).
  const setTypeIdx = addFuncType(ctx, [extern, f64, extern], [i32]);
  const setFuncIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__ta_dyn_set_elem", setFuncIdx);
  {
    const fctx = makeFctx(
      "__ta_dyn_set_elem",
      [
        { name: "recv", type: extern },
        { name: "idx", type: f64 },
        { name: "v", type: extern },
      ],
      i32,
    );
    const dv = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
    const kind = allocLocal(fctx, "kind", i32);
    const es = allocLocal(fctx, "es", i32);
    const len = allocLocal(fctx, "len", i32);
    const i = allocLocal(fctx, "i", i32);
    const vf = allocLocal(fctx, "vf", f64);
    const arr = allocLocal(fctx, "arr", { kind: "ref", typeIdx: arrTypeIdx });
    const off = allocLocal(fctx, "off", i32);
    const le = allocLocal(fctx, "le", i32);
    // v first (spec order). `__unbox_number` is the finalize-safe ToNumber the
    // vec write arms use (already a DEFINED func — no import add, no funcIdx
    // shift at finalize; full ToPrimitive observability is a follow-on).
    const unboxNumIdx = ctx.funcMap.get("__unbox_number");
    fctx.body.push({ op: "local.get", index: 2 });
    if (unboxNumIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: unboxNumIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: Number.NaN });
    }
    fctx.body.push({ op: "local.set", index: vf });
    pushDynPreamble(ctx, fctx, dynIdx, dv, kind, es, len);
    pushIsValidIntegerIndex(fctx, 1, i, len);
    const store: Instr[] = [];
    const saved = fctx.body;
    fctx.body = store;
    pushElemAddr(ctx, fctx, dynIdx, vecTypeIdx, dv, i, es, arr, off, le);
    fctx.body.push(...emitDynEncodeDispatch(ctx, fctx, kind, arr, off, vf, le, arrTypeIdx));
    fctx.body = saved;
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: store });
    fctx.body.push({ op: "i32.const", value: 1 });
    pushDefinedFunc(ctx, setFuncIdx, {
      name: "__ta_dyn_set_elem",
      typeIdx: setTypeIdx,
      locals: fctx.locals,
      body: fctx.body,
      exported: false,
    });
  }

  // ── __ta_dyn_has_idx ──
  const hasTypeIdx = addFuncType(ctx, [extern, f64], [i32]);
  const hasFuncIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__ta_dyn_has_idx", hasFuncIdx);
  {
    const fctx = makeFctx(
      "__ta_dyn_has_idx",
      [
        { name: "recv", type: extern },
        { name: "idx", type: f64 },
      ],
      i32,
    );
    const dv = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
    const kind = allocLocal(fctx, "kind", i32);
    const es = allocLocal(fctx, "es", i32);
    const len = allocLocal(fctx, "len", i32);
    const i = allocLocal(fctx, "i", i32);
    pushDynPreamble(ctx, fctx, dynIdx, dv, kind, es, len);
    pushIsValidIntegerIndex(fctx, 1, i, len);
    pushDefinedFunc(ctx, hasFuncIdx, {
      name: "__ta_dyn_has_idx",
      typeIdx: hasTypeIdx,
      locals: fctx.locals,
      body: fctx.body,
      exported: false,
    });
  }

  return { getElem: getFuncIdx, setElem: setFuncIdx, hasIdx: hasFuncIdx };
}

/** Named intrinsic props served by the dyn-view [[Get]]/[[HasProperty]] arms. */
type NamedProp = "length" | "byteLength" | "byteOffset" | "BYTES_PER_ELEMENT" | "buffer" | "constructor";
const NAMED_PROPS: readonly NamedProp[] = [
  "length",
  "byteLength",
  "byteOffset",
  "BYTES_PER_ELEMENT",
  "buffer",
  "constructor",
];

/**
 * (#3177) Finalize-time fill: prepend the `$__ta_dyn_view` MOP arms into the
 * standalone dynamic-object natives. Must run AFTER the generic vec fills
 * (`fillExternGetIdxVecArms` / `fillExternSetVecArms` /
 * `fillDynamicForinVecArms`) so this arm ends up in FRONT of theirs (each fill
 * prepends at body index 0 — last fill wins the front slot).
 */
export function fillTaDynViewMopArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return; // host imports own the dynamic path
  const dynIdx = ctx.taDynViewTypeIdx;
  if (dynIdx < 0) return;
  const helpers = ensureTaDynMopElemHelpers(ctx);
  if (!helpers) return;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return;
  const { vecTypeIdx } = i32ByteVec(ctx);
  const tpkIdx = ctx.funcMap.get("__to_property_key");
  const strToNumIdx = ctx.funcMap.get("__str_to_number");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (
    tpkIdx === undefined ||
    strToNumIdx === undefined ||
    numToStringIdx === undefined ||
    boxNumIdx === undefined ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined
  ) {
    return; // object runtime not in this module — nothing routes here anyway
  }

  const findFn = (name: string) => {
    const idx = ctx.funcMap.get(name);
    return idx === undefined ? undefined : definedFuncAt(ctx, idx);
  };
  const undef = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];

  // flatten(cast $AnyString (any.convert_extern <keyLocal>)) — key is already
  // known to be an $AnyString when this runs.
  const flattenKey = (keyLocal: number): Instr[] => [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: strFlattenIdx },
  ];
  // i32: normalized key (externref local) == the literal
  const keyIs = (keyLocal: number, lit: string): Instr[] => [
    ...flattenKey(keyLocal),
    ...nativeStringLiteralInstrs(ctx, lit),
    { op: "call", funcIdx: strEqualsIdx },
  ];
  // i32: CanonicalNumericIndexString — number_toString(n) == key || key == "-0"
  const keyIsCanonical = (keyLocal: number, nLocal: number): Instr[] => [
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: strToNumIdx },
    { op: "local.set", index: nLocal },
    { op: "local.get", index: nLocal },
    { op: "call", funcIdx: numToStringIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: strFlattenIdx },
    ...flattenKey(keyLocal),
    { op: "call", funcIdx: strEqualsIdx },
    ...keyIs(keyLocal, "-0"),
    { op: "i32.or" },
  ];

  // Named-prop value instrs (dv/kind/es/len locals must be populated).
  const namedValue = (prop: NamedProp, dv: number, kind: number, es: number, len: number): Instr[] => {
    switch (prop) {
      case "length":
        return [{ op: "local.get", index: len }, { op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }];
      case "byteLength":
        return [
          { op: "local.get", index: len },
          { op: "local.get", index: es },
          { op: "i32.mul" },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: boxNumIdx },
        ];
      case "byteOffset":
        return [
          { op: "local.get", index: dv },
          { op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: boxNumIdx },
        ];
      case "BYTES_PER_ELEMENT":
        return [{ op: "local.get", index: es }, { op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }];
      case "buffer":
        // Identity: the SAME backing byte-vec ref `new ArrayBuffer(n)` produced
        // (an ArrayBuffer IS the bare $__vec_i32_byte standalone), so
        // `ta.buffer === buffer` holds and $DETACHBUFFER's len=-1 write is
        // observable through it.
        return [
          { op: "local.get", index: dv },
          { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 },
          { op: "extern.convert_any" },
        ];
      case "constructor": {
        // Runtime kind → the per-kind $__ta_ctor SINGLETON (the same object a
        // bare ctor identifier mention produces — ref.eq identity, #3177).
        // Kinds with no registered singleton (ctor never mentioned as a value
        // in this module) answer undefined.
        const out: Instr[] = [];
        for (const [k, globalIdx] of [...ctx.taCtorSingletonGlobals.entries()].sort((a, b) => a[0] - b[0])) {
          out.push({ op: "local.get", index: kind });
          out.push({ op: "i32.const", value: k });
          out.push({ op: "i32.eq" });
          out.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "global.get", index: globalIdx }, { op: "extern.convert_any" }, { op: "return" }],
          });
        }
        out.push(...undef());
        return out;
      }
    }
  };

  // ── __extern_get_idx / __extern_has_idx: numeric fast paths ──
  for (const [fnName, helperIdx] of [
    ["__extern_get_idx", helpers.getElem],
    ["__extern_has_idx", helpers.hasIdx],
  ] as const) {
    const fn = findFn(fnName);
    if (!fn) continue;
    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: dynIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: helperIdx },
          { op: "return" },
        ],
      },
    ];
    fn.body.unshift(...arm);
  }

  // ── Shared string-key arm builder for get/has/set-like natives. ──
  // Layout: params 0=obj 1=key [2=value]; appends locals; the arm:
  //   if !ref.test dyn(obj) → fall through
  //   dv/kind/es/len preamble
  //   key = __to_property_key(key) → kLocal; non-string key → miss
  //   named props (get/has only)
  //   canonical? → element semantics ; else → ordinary miss
  const buildStringKeyArm = (
    fn: { locals: { name: string; type: ValType }[]; body: Instr[] },
    numParams: number,
    mode: "get" | "has" | "set" | "reflect_set" | "delete",
  ): void => {
    const base = numParams + fn.locals.length;
    const aAny = base; // anyref scratch
    const aDv = base + 1;
    const aKind = base + 2;
    const aEs = base + 3;
    const aLen = base + 4;
    const aKey = base + 5; // normalized key externref
    const aN = base + 6; // parsed numeric key f64
    fn.locals.push(
      { name: "__tam_any", type: { kind: "anyref" } },
      { name: "__tam_dv", type: { kind: "ref_null", typeIdx: dynIdx } },
      { name: "__tam_kind", type: { kind: "i32" } },
      { name: "__tam_es", type: { kind: "i32" } },
      { name: "__tam_len", type: { kind: "i32" } },
      { name: "__tam_key", type: { kind: "externref" } },
      { name: "__tam_n", type: { kind: "f64" } },
    );

    // Build the inner (receiver IS dyn-view) body with a mini fctx so the
    // shared push* helpers can be reused. The helpers may allocLocal scratch
    // slots — allocLocal computes `params.length + locals.length`, so the mini
    // fctx must carry a params array of the native's true arity (the appended
    // locals then land at the correct indices).
    const inner: Instr[] = [];
    const fctxLike = {
      body: inner,
      locals: fn.locals,
      params: new Array(numParams).fill({ name: "p", type: { kind: "externref" } }),
      localMap: new Map(),
    } as unknown as FunctionContext;
    // dv = cast(any) ; kind/es/len
    inner.push({ op: "local.get", index: aAny });
    inner.push({ op: "ref.cast", typeIdx: dynIdx });
    inner.push({ op: "local.set", index: aDv });
    inner.push({ op: "local.get", index: aDv });
    inner.push({ op: "ref.as_non_null" });
    inner.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
    inner.push({ op: "local.set", index: aKind });
    pushElemSizeForKind(fctxLike, aKind);
    inner.push({ op: "local.set", index: aEs });
    pushTaDynViewInBoundsLen(ctx, fctxLike, aDv, aEs);
    inner.push({ op: "local.set", index: aLen });
    // key = __to_property_key(key)
    inner.push({ op: "local.get", index: 1 });
    inner.push({ op: "call", funcIdx: tpkIdx });
    inner.push({ op: "local.set", index: aKey });
    // Non-string key (Symbol / opaque) → ordinary miss for this arm.
    const missInstrs = (): Instr[] => {
      switch (mode) {
        case "get":
          return [...undef(), { op: "return" }];
        case "has":
          return [{ op: "i32.const", value: 0 }, { op: "return" }];
        case "set":
          return [{ op: "return" }]; // void — expando writes are a follow-on
        case "reflect_set":
          return [{ op: "i32.const", value: 1 }, { op: "return" }]; // OrdinarySet on extensible → true
        case "delete":
          return [{ op: "i32.const", value: 1 }, { op: "return" }]; // no own prop → true
      }
    };
    inner.push({ op: "local.get", index: aKey });
    inner.push({ op: "any.convert_extern" });
    inner.push({ op: "ref.test", typeIdx: anyStrTypeIdx });
    inner.push({ op: "i32.eqz" });
    inner.push({ op: "if", blockType: { kind: "empty" }, then: missInstrs() });

    // Named intrinsic props (get → value, has → 1). Set/delete on named props
    // fall to the miss behavior (read-only intrinsics; per-spec they are
    // accessor/proto props — a data write is a silent accessor-without-setter
    // failure in sloppy mode, matching the miss no-op).
    if (mode === "get" || mode === "has") {
      for (const prop of NAMED_PROPS) {
        inner.push(...keyIs(aKey, prop));
        inner.push({
          op: "if",
          blockType: { kind: "empty" },
          then:
            mode === "get"
              ? [...namedValue(prop, aDv, aKind, aEs, aLen), { op: "return" }]
              : [{ op: "i32.const", value: 1 }, { op: "return" }],
        });
      }
    }

    // Canonical numeric key → element semantics; else ordinary miss.
    inner.push(...keyIsCanonical(aKey, aN));
    const canonThen: Instr[] = (() => {
      switch (mode) {
        case "get":
          return [
            { op: "local.get", index: 0 },
            { op: "local.get", index: aN },
            { op: "call", funcIdx: helpers.getElem },
            { op: "return" },
          ];
        case "has":
          return [
            { op: "local.get", index: 0 },
            { op: "local.get", index: aN },
            { op: "call", funcIdx: helpers.hasIdx },
            { op: "return" },
          ];
        case "set":
          return [
            { op: "local.get", index: 0 },
            { op: "local.get", index: aN },
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: helpers.setElem },
            { op: "drop" },
            { op: "return" },
          ];
        case "reflect_set":
          return [
            { op: "local.get", index: 0 },
            { op: "local.get", index: aN },
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: helpers.setElem },
            { op: "return" },
          ];
        case "delete":
          // §10.4.5.8: valid index → false (non-configurable element per the
          // pre-ES2021 view; test262 asserts delete sample[0] === false),
          // invalid/OOB/detached → true.
          return [
            { op: "local.get", index: 0 },
            { op: "local.get", index: aN },
            { op: "call", funcIdx: helpers.hasIdx },
            { op: "i32.eqz" },
            { op: "return" },
          ];
      }
    })();
    inner.push({ op: "if", blockType: { kind: "empty" }, then: canonThen });
    inner.push(...missInstrs());

    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: aAny },
      { op: "ref.test", typeIdx: dynIdx },
      { op: "if", blockType: { kind: "empty" }, then: inner },
    ];
    fn.body.unshift(...arm);
  };

  const getFn = findFn("__extern_get");
  if (getFn) buildStringKeyArm(getFn, 2, "get");
  const hasFn = findFn("__extern_has");
  if (hasFn) buildStringKeyArm(hasFn, 2, "has");
  const setFn = findFn("__extern_set");
  if (setFn) buildStringKeyArm(setFn, 3, "set");
  const reflectSetFn = findFn("__reflect_set");
  if (reflectSetFn) buildStringKeyArm(reflectSetFn, 3, "reflect_set");
  const delFn = findFn("__delete_property");
  if (delFn) buildStringKeyArm(delFn, 2, "delete");

  // ── __object_keys: enumerate "0".."len-1" (§10.4.5.11 OwnPropertyKeys —
  // integer indices in ascending order; expando keys are a follow-on). ──
  const keysFn = findFn("__object_keys");
  if (keysFn && objVecNewIdx !== undefined && objVecPushIdx !== undefined) {
    const base = 1 + keysFn.locals.length;
    const kAny = base;
    const kDv = base + 1;
    const kKind = base + 2;
    const kEs = base + 3;
    const kLen = base + 4;
    const kVec = base + 5;
    const kI = base + 6;
    keysFn.locals.push(
      { name: "__tam_any", type: { kind: "anyref" } },
      { name: "__tam_dv", type: { kind: "ref_null", typeIdx: dynIdx } },
      { name: "__tam_kind", type: { kind: "i32" } },
      { name: "__tam_es", type: { kind: "i32" } },
      { name: "__tam_len", type: { kind: "i32" } },
      { name: "__tam_vec", type: { kind: "externref" } },
      { name: "__tam_i", type: { kind: "i32" } },
    );
    const inner: Instr[] = [];
    const fctxLike = {
      body: inner,
      locals: keysFn.locals,
      params: [{ name: "p", type: { kind: "externref" } }],
      localMap: new Map(),
    } as unknown as FunctionContext;
    inner.push({ op: "local.get", index: kAny });
    inner.push({ op: "ref.cast", typeIdx: dynIdx });
    inner.push({ op: "local.set", index: kDv });
    inner.push({ op: "local.get", index: kDv });
    inner.push({ op: "ref.as_non_null" });
    inner.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
    inner.push({ op: "local.set", index: kKind });
    pushElemSizeForKind(fctxLike, kKind);
    inner.push({ op: "local.set", index: kEs });
    pushTaDynViewInBoundsLen(ctx, fctxLike, kDv, kEs);
    inner.push({ op: "local.set", index: kLen });
    inner.push({ op: "call", funcIdx: objVecNewIdx });
    inner.push({ op: "local.set", index: kVec });
    inner.push({ op: "i32.const", value: 0 });
    inner.push({ op: "local.set", index: kI });
    inner.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: kI },
            { op: "local.get", index: kLen },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: kVec },
            { op: "local.get", index: kI },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: numToStringIdx },
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: kI },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: kI },
            { op: "br", depth: 0 },
          ],
        },
      ],
    });
    inner.push({ op: "local.get", index: kVec });
    inner.push({ op: "return" });
    keysFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: kAny },
      { op: "ref.test", typeIdx: dynIdx },
      { op: "if", blockType: { kind: "empty" }, then: inner },
    );
  }

  // ── (#3177 slice 3) Proto-identity + isExtensible arms ────────────────────
  //
  // `Object.getPrototypeOf(view) === TA.prototype` (ctors/*/defined-length,
  // returns-new-instance, returns-object, …) needs BOTH sides to resolve to
  // the per-kind `$NativeProto` glue SINGLETON — the same object a static
  // `<View>.prototype` value read yields (one lazily-initialized global per
  // view brand, `emitLazyNativeProtoGet`). Register the glue for every kind
  // up front (idempotent; the memberCsv string is shared across kinds), then
  // switch on the runtime `kind`.
  const protoKinds: { kind: number; brand: number }[] = [];
  for (let k = 0; k < TA_CTOR_KINDS.length; k++) {
    const brand = ensureTypedArrayViewNativeProtoGlue(ctx, TA_CTOR_KINDS[k]!);
    if (brand !== undefined) protoKinds.push({ kind: k, brand });
  }
  // kind (i32 local) → push the glue externref → return. Emitted via a body
  // swap on `fctxLike` because emitLazyNativeProtoGet pushes onto fctx.body.
  const pushKindToProtoSwitch = (fctxLike: FunctionContext, kindLocal: number): void => {
    for (const { kind: k, brand } of protoKinds) {
      const armThen: Instr[] = [];
      const saved = fctxLike.body;
      fctxLike.body = armThen;
      const ok = emitLazyNativeProtoGet(ctx, fctxLike, brand);
      fctxLike.body = saved;
      if (!ok) continue;
      armThen.push({ op: "return" });
      fctxLike.body.push({ op: "local.get", index: kindLocal });
      fctxLike.body.push({ op: "i32.const", value: k });
      fctxLike.body.push({ op: "i32.eq" });
      fctxLike.body.push({ op: "if", blockType: { kind: "empty" }, then: armThen });
    }
  };

  // __getPrototypeOf(externref) -> externref: dyn-view receiver → per-kind
  // `<View>.prototype` glue (§10.4.5 views are ordinary here — their
  // [[Prototype]] IS the intrinsic per-kind prototype).
  const getProtoFn = findFn("__getPrototypeOf");
  if (getProtoFn && protoKinds.length > 0) {
    const base = 1 + getProtoFn.locals.length;
    const pAny = base;
    const pKind = base + 1;
    getProtoFn.locals.push(
      { name: "__tap_any", type: { kind: "anyref" } },
      { name: "__tap_kind", type: { kind: "i32" } },
    );
    const inner: Instr[] = [];
    const fctxLike = {
      body: inner,
      locals: getProtoFn.locals,
      params: [{ name: "p", type: { kind: "externref" } }],
      localMap: new Map(),
    } as unknown as FunctionContext;
    inner.push({ op: "local.get", index: pAny });
    inner.push({ op: "ref.cast", typeIdx: dynIdx });
    inner.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
    inner.push({ op: "local.set", index: pKind });
    pushKindToProtoSwitch(fctxLike, pKind);
    inner.push({ op: "ref.null.extern" });
    inner.push({ op: "return" });
    getProtoFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: pAny },
      { op: "ref.test", typeIdx: dynIdx },
      { op: "if", blockType: { kind: "empty" }, then: inner },
    );
  }

  // __object_isExtensible(externref) -> i32: a live view IS extensible
  // (§10.4.5 views are ordinary wrt [[IsExtensible]]; no preventExtensions
  // state exists on `$__ta_dyn_view` yet — the expando slice owns that).
  const isExtFn = findFn("__object_isExtensible");
  if (isExtFn) {
    isExtFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: dynIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
    );
  }

  // __extern_get $__ta_ctor receiver arm: `TA.prototype` (→ the SAME per-kind
  // glue as getPrototypeOf above, closing the identity) and
  // `TA.BYTES_PER_ELEMENT`. Other keys fall through to the original body
  // (current behavior: undefined). Only when a `$__ta_ctor` value can exist.
  if (getFn && ctx.taCtorTypeIdx >= 0 && protoKinds.length > 0) {
    const ctorIdx = ctx.taCtorTypeIdx;
    const base = 2 + getFn.locals.length;
    const cAny = base;
    const cKind = base + 1;
    const cKey = base + 2;
    getFn.locals.push(
      { name: "__tac_any", type: { kind: "anyref" } },
      { name: "__tac_kind", type: { kind: "i32" } },
      { name: "__tac_key", type: { kind: "externref" } },
    );
    const inner: Instr[] = [];
    const fctxLike = {
      body: inner,
      locals: getFn.locals,
      params: [
        { name: "p0", type: { kind: "externref" } },
        { name: "p1", type: { kind: "externref" } },
      ],
      localMap: new Map(),
    } as unknown as FunctionContext;
    inner.push({ op: "local.get", index: cAny });
    inner.push({ op: "ref.cast", typeIdx: ctorIdx });
    inner.push({ op: "struct.get", typeIdx: ctorIdx, fieldIdx: 0 });
    inner.push({ op: "local.set", index: cKind });
    inner.push({ op: "local.get", index: 1 });
    inner.push({ op: "call", funcIdx: tpkIdx });
    inner.push({ op: "local.set", index: cKey });
    const strKeyed: Instr[] = [];
    const savedInner = fctxLike.body;
    fctxLike.body = strKeyed;
    strKeyed.push(...keyIs(cKey, "prototype"));
    {
      const protoThen: Instr[] = [];
      const saved2 = fctxLike.body;
      fctxLike.body = protoThen;
      pushKindToProtoSwitch(fctxLike, cKind);
      fctxLike.body = saved2;
      protoThen.push(...undef());
      protoThen.push({ op: "return" });
      strKeyed.push({ op: "if", blockType: { kind: "empty" }, then: protoThen });
    }
    strKeyed.push(...keyIs(cKey, "BYTES_PER_ELEMENT"));
    {
      const bpeThen: Instr[] = [];
      const saved2 = fctxLike.body;
      fctxLike.body = bpeThen;
      pushElemSizeForKind(fctxLike, cKind);
      fctxLike.body = saved2;
      bpeThen.push({ op: "f64.convert_i32_s" });
      bpeThen.push({ op: "call", funcIdx: boxNumIdx });
      bpeThen.push({ op: "return" });
      strKeyed.push({ op: "if", blockType: { kind: "empty" }, then: bpeThen });
    }
    fctxLike.body = savedInner;
    // Only string keys take the fast checks; anything else falls through.
    inner.push({ op: "local.get", index: cKey });
    inner.push({ op: "any.convert_extern" });
    inner.push({ op: "ref.test", typeIdx: anyStrTypeIdx });
    inner.push({ op: "if", blockType: { kind: "empty" }, then: strKeyed });
    getFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: cAny },
      { op: "ref.test", typeIdx: ctorIdx },
      { op: "if", blockType: { kind: "empty" }, then: inner },
    );
  }
}
