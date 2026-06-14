// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1320 Slice 1 — standalone (no-JS-host) iteration protocol bridge.
 *
 * In JS-host mode the iteration protocol is delivered by four `env::__iterator*`
 * host imports (see `addIteratorImports` in index.ts). Under `--target wasi` /
 * standalone there is no JS host, so this module registers the SAME four
 * funcMap names (`__iterator`, `__iterator_next`, `__iterator_return`,
 * `__iterator_rest`) as **emitted Wasm functions**. Because the consumer code
 * (for-of loop, spread, array-dstr) looks the operations up by name, it binds
 * to these native fns transparently — no consumer changes.
 *
 * **Canonical representation (Slice 1).** Rather than a generic GetIterator over
 * every compiled iterable shape (generators, Map/Set, class iterables — those
 * are later slices), Slice 1 standardizes on a single **canonical externref
 * `$Vec`** as the iterator backing store. The *caller* (e.g.
 * `compileArrayIteratorMethod`, which runs during expression codegen and has an
 * `fctx`) boxes each element to externref on-build and hands the native runtime
 * an externref vec. That keeps the fctx-less native bodies trivial: no
 * per-elemKind `ref.test`/box switch and no `coerceType` (which needs an fctx).
 *
 * The native iterator-record:
 *   (struct $__IterRec (field $kind i32)                  ;; reserved (Slice 1b+)
 *                       (field $vec  (ref null $vecExtern));; canonical externref vec
 *                       (field $idx  (mut i32)))           ;; cursor
 *   $kind is currently always 3 ($Vec); reserved for kind=1 native-gen (Slice 1b).
 *
 * Spec: ECMA-262 §7.4 (GetIterator / IteratorStep / IteratorValue /
 * IteratorClose). See plan/issues/1320-array-from-externref-iterator-bridge.md.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";

/** Slice-1 IterRec kind tag for a canonical externref `$Vec`. */
const ITER_KIND_VEC = 3;

/**
 * (#2038) IterRec kind tag for a USER iterator: a general `{next()}`-protocol
 * object obtained from a custom iterable's `[Symbol.iterator]()`. The `vec`
 * field is null; the iterator object is held in `userIter` (field 3, externref)
 * and each `__iterator_next` step calls `userIter.next()` via
 * `__extern_method_call` and reads `.value`/`.done`. This covers BOTH sync
 * `for-of` and (sync-backed) async `for await` over a user iterable, which
 * previously trapped `illegal cast` in the vec-only native runtime.
 */
const ITER_KIND_USER = 1;

/**
 * Lazily register (or fetch) the `$__IterRec` GC struct type. Mirrors
 * `ensureNativeGeneratorResultType` (generators-native.ts) — one struct per
 * module, cached via `ctx.structMap`.
 */
export function getOrRegisterIterRecType(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__IterRec");
  if (existing !== undefined) return existing;

  // The canonical externref vec the record cursors over.
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });

  // Field order is load-bearing: fieldIdx kind=0, vec=1, idx=2 (the vec path).
  // (#2038) userIter=3 — a mutable externref holding the user `{next()}`
  // iterator object for the USER carrier (null on the vec path).
  const fields = [
    { name: "kind", type: { kind: "i32" as const }, mutable: false },
    { name: "vec", type: { kind: "ref_null" as const, typeIdx: vecTypeIdx }, mutable: false },
    { name: "idx", type: { kind: "i32" as const }, mutable: true },
    { name: "userIter", type: { kind: "externref" as const }, mutable: true },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: "__IterRec", fields });
  ctx.structMap.set("__IterRec", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "__IterRec");
  ctx.structFields.set("__IterRec", fields);
  return typeIdx;
}

/**
 * #1320 Slice 1 — register the four iteration-protocol operations as native
 * Wasm functions (standalone/WASI). Idempotent: guards on `funcMap.has`.
 *
 * Signatures match the JS-host imports exactly so consumer codegen is
 * byte-identical:
 *   __iterator(externref) -> externref               (GetIterator)
 *   __iterator_next(externref) -> (i32 done, externref value)  (IteratorStep)
 *   __iterator_return(externref) -> ()               (IteratorClose)
 *   __iterator_rest(externref) -> externref          (drain remainder → vec)
 *
 * The argument to `__iterator` is, in Slice 1, an externref-wrapped canonical
 * externref `$Vec` (the caller box-builds it). `__iterator` wraps it in an
 * `$IterRec`; `__iterator_next` walks the vec by index.
 */
export function ensureNativeIteratorRuntime(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__iterator")) return;

  const iterRecTypeIdx = getOrRegisterIterRecType(ctx);
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  const iterRecRef: ValType = { kind: "ref", typeIdx: iterRecTypeIdx };
  const vecRefNull: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };

  // (#2038) USER `{next()}`-protocol carrier dependencies. Set up BEFORE building
  // the native bodies so funcMap indices / string-const globals are stable when
  // captured. `__extern_method_call` (+ `__extern_get`/`__apply_closure`) is
  // filled at FINALIZE — referencing its reserved funcIdx is fine (finalize
  // fills the body, not the index). Force-register the method-name string
  // constants so `stringConstantExternrefInstrs` materializes them.
  ensureObjectRuntime(ctx);
  for (const s of ["@@iterator", "next", "value", "done"]) addStringConstantGlobal(ctx, s);
  const externMethodCallIdx = ctx.funcMap.get("__extern_method_call");
  // Per-field getters for the {value, done} next()-result. They are emitted on
  // demand when a `.value`/`.done` access is compiled; on the USER iterator path
  // the result object is host/$Object-shaped, so use the generic host get via
  // `__extern_get` (resolves own + prototype) keyed by the field-name string,
  // which is always available once ensureObjectRuntime ran.
  const externGetIdx = ctx.funcMap.get("__extern_get");
  // `__is_truthy(externref) -> i32` for the §7.2.15 `done` flag (ToBoolean).
  // Emitted natively in standalone; resolved by funcMap name.
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  // USER carrier is only wired when the host-dispatch helpers exist (they do in
  // standalone after ensureObjectRuntime). If absent (shouldn't happen), the
  // vec-only path is preserved and a non-vec subject keeps trapping as before.
  const userCarrierWired = externMethodCallIdx !== undefined && externGetIdx !== undefined && isTruthyIdx !== undefined;

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

  // --- __iterator(obj: externref) -> externref (the $IterRec, as externref) ---
  // GetIterator §7.4.1.
  //   - obj is a canonical externref `$Vec` (the common array path)  → build
  //     $IterRec{kind:VEC, vec, idx:0, userIter:null}.
  //   - (#2038) otherwise obj is a USER iterable (custom `{[Symbol.iterator]()
  //     {…}}`) → obtain its iterator object via `obj[@@iterator]()` and build
  //     $IterRec{kind:USER, vec:null, idx:0, userIter}. If `@@iterator` resolves
  //     to nothing (obj is ALREADY an iterator with a bare `next`), fall back to
  //     using obj itself as the iterator object.
  // local 0 = obj (param, externref); local 1 = objAny (anyref); local 2 = userIter (externref)
  const emptyArgsVec: Instr[] = [
    // $vecExtern{ length: 0, data: null } → externref
    { op: "i32.const", value: 0 },
    { op: "ref.null", typeIdx: arrTypeIdx } as Instr,
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" } as Instr,
  ];
  const iteratorBody: Instr[] = [
    // objAny = any.convert_extern(obj)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: vecTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        // VEC carrier: $IterRec{VEC, vec, 0, userIter:null}
        { op: "i32.const", value: ITER_KIND_VEC },
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "i32.const", value: 0 },
        { op: "ref.null.extern" } as Instr,
        { op: "struct.new", typeIdx: iterRecTypeIdx },
        { op: "extern.convert_any" } as Instr,
      ],
      else: userCarrierWired
        ? [
            // userIter = obj[@@iterator]()  (null if obj has no @@iterator)
            { op: "local.get", index: 0 },
            ...stringConstantExternrefInstrs(ctx, "@@iterator"),
            ...emptyArgsVec,
            { op: "call", funcIdx: externMethodCallIdx! },
            { op: "local.tee", index: 2 },
            { op: "ref.is_null" } as Instr,
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              // No @@iterator → obj is itself the iterator (has `next`).
              then: [{ op: "local.get", index: 0 }],
              else: [{ op: "local.get", index: 2 }],
            } as unknown as Instr,
            { op: "local.set", index: 2 },
            // $IterRec{USER, vec:null, idx:0, userIter}
            { op: "i32.const", value: ITER_KIND_USER },
            { op: "ref.null", typeIdx: vecTypeIdx } as Instr,
            { op: "i32.const", value: 0 },
            { op: "local.get", index: 2 },
            { op: "struct.new", typeIdx: iterRecTypeIdx },
            { op: "extern.convert_any" } as Instr,
          ]
        : [
            // USER carrier unavailable — preserve the legacy hard cast so the
            // failure mode is unchanged (loud trap) rather than silently wrong.
            { op: "i32.const", value: ITER_KIND_VEC },
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: vecTypeIdx },
            { op: "i32.const", value: 0 },
            { op: "ref.null.extern" } as Instr,
            { op: "struct.new", typeIdx: iterRecTypeIdx },
            { op: "extern.convert_any" } as Instr,
          ],
    } as unknown as Instr,
  ];
  registerNative(
    "__iterator",
    [{ kind: "externref" }],
    [{ kind: "externref" }],
    [
      { name: "objAny", type: { kind: "anyref" } },
      { name: "userIter", type: { kind: "externref" } },
    ],
    iteratorBody,
  );

  // --- __iterator_next(recExt: externref) -> (i32 done, externref value) ---
  // IteratorStep + IteratorValue §7.4.5/§7.4.6. Read the canonical externref
  // vec at the cursor; advance on a live element, else report done. Body built
  // with explicit done/value locals so the multi-value results are emitted in
  // ABI order (done, value).
  //   local 0 = recExt (param, externref)
  //   local 1 = rec    ($IterRec)
  //   local 2 = vec    (ref null $vecExtern)
  //   local 3 = i      (i32 cursor)
  //   local 4 = done   (i32)
  //   local 5 = value  (externref)
  //   local 6 = res    (externref — USER next() result, #2038)
  registerNative(
    "__iterator_next",
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
    [
      { name: "rec", type: iterRecRef },
      { name: "vec", type: vecRefNull },
      { name: "i", type: { kind: "i32" } },
      { name: "done", type: { kind: "i32" } },
      { name: "value", type: { kind: "externref" } },
      { name: "res", type: { kind: "externref" } },
    ],
    buildIteratorNextBody(ctx, iterRecTypeIdx, vecTypeIdx, arrTypeIdx, {
      userCarrierWired,
      externMethodCallIdx,
      externGetIdx,
      isTruthyIdx,
      emptyArgsVec,
    }),
  );

  // --- __iterator_return(recExt: externref) -> ()  (IteratorClose §7.4.8) ---
  // Slice 1: canonical-vec iterators have no user `.return` → no-op.
  registerNative("__iterator_return", [{ kind: "externref" }], [], [], []);

  // --- __iterator_rest(recExt: externref) -> externref  ([...rest] drain) ---
  // Drain the remaining elements of the canonical vec into a fresh externref
  // vec. Slice 1: shallow-copy from the cursor to the end.
  //   local 0 = recExt
  //   local 1 = rec   ($IterRec)
  //   local 2 = vec   (ref null $vecExtern)
  //   local 3 = i     (i32 cursor)
  //   local 4 = len   (i32)
  //   local 5 = out   (ref null $arrExtern)  fresh data array
  //   local 6 = j     (i32 write cursor)
  registerNative(
    "__iterator_rest",
    [{ kind: "externref" }],
    [{ kind: "externref" }],
    [
      { name: "rec", type: iterRecRef },
      { name: "vec", type: vecRefNull },
      { name: "i", type: { kind: "i32" } },
      { name: "len", type: { kind: "i32" } },
      { name: "out", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "j", type: { kind: "i32" } },
    ],
    buildIteratorRestBody(iterRecTypeIdx, vecTypeIdx, arrTypeIdx),
  );
}

/**
 * Build the `__iterator_next` body with explicit done/value computation so the
 * multi-value `(i32 done, externref value)` results are emitted in ABI order.
 * Locals: 0=recExt(param), 1=rec, 2=vec, 3=i, 4=done(i32), 5=value(externref),
 * 6=res(externref, USER next() result).
 */
interface UserNextDeps {
  userCarrierWired: boolean;
  externMethodCallIdx: number | undefined;
  externGetIdx: number | undefined;
  isTruthyIdx: number | undefined;
  emptyArgsVec: Instr[];
}
function buildIteratorNextBody(
  ctx: CodegenContext,
  iterRecTypeIdx: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  deps: UserNextDeps,
): Instr[] {
  // The vec-carrier step (existing behavior), computing done(4)/value(5).
  const vecStep: Instr[] = [
    // vec = rec.vec
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 2 },
    // i = rec.idx
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 3 },
    // done = (vec == null) | (i >= vec.length)
    { op: "local.get", index: 2 },
    { op: "ref.is_null" } as Instr,
    { op: "local.get", index: 3 },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "i32.ge_s" },
    { op: "i32.or" },
    { op: "local.set", index: 4 },
    // value default = undefined-extern
    { op: "ref.null.extern" } as Instr,
    { op: "local.set", index: 5 },
    // if (!done) { value = vec.data[i]; rec.idx = i + 1; }
    { op: "local.get", index: 4 },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 3 },
        { op: "array.get", typeIdx: arrTypeIdx },
        { op: "local.set", index: 5 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 3 },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx: iterRecTypeIdx, fieldIdx: 2 } as Instr,
      ],
      else: [],
    } as unknown as Instr,
  ];

  // (#2038) The USER-carrier step (§7.4.4 IteratorNext + §7.4.6 IteratorValue):
  //   res = userIter.next();  done = ToBoolean(res.done);  value = res.value
  // Result-not-an-object is left to the host get returning undefined (the common
  // user-iterator shapes always return an object); a hard TypeError on a
  // non-object result is a follow-up refinement.
  const userStep: Instr[] = deps.userCarrierWired
    ? [
        // res = __extern_method_call(rec.userIter, "next", emptyArgs)
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
        ...stringConstantExternrefInstrs(ctx, "next"),
        ...deps.emptyArgsVec,
        { op: "call", funcIdx: deps.externMethodCallIdx! },
        { op: "local.set", index: 6 },
        // done = ToBoolean(__extern_get(res, "done"))
        { op: "local.get", index: 6 },
        ...stringConstantExternrefInstrs(ctx, "done"),
        { op: "call", funcIdx: deps.externGetIdx! },
        { op: "call", funcIdx: deps.isTruthyIdx! },
        { op: "local.set", index: 4 },
        // value = done ? undefined : __extern_get(res, "value")
        { op: "local.get", index: 4 },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "ref.null.extern" } as Instr],
          else: [
            { op: "local.get", index: 6 },
            ...stringConstantExternrefInstrs(ctx, "value"),
            { op: "call", funcIdx: deps.externGetIdx! },
          ],
        } as unknown as Instr,
        { op: "local.set", index: 5 },
      ]
    : // USER carrier not wired — never reached (kind is never USER without it).
      [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: 4 },
        { op: "ref.null.extern" } as Instr,
        { op: "local.set", index: 5 },
      ];

  return [
    // rec = cast(any.convert_extern(recExt))
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
    { op: "local.set", index: 1 },
    // if (rec.kind == USER) { userStep } else { vecStep }
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: ITER_KIND_USER },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: userStep,
      else: vecStep,
    } as unknown as Instr,
    // results in ABI order: (done, value)
    { op: "local.get", index: 4 },
    { op: "local.get", index: 5 },
  ];
}

/**
 * Build the `__iterator_rest` body: copy the canonical vec's elements from the
 * cursor to the end into a fresh externref vec, returned as externref.
 * Locals: 0=recExt(param), 1=rec, 2=vec, 3=i, 4=len, 5=out(arr), 6=j.
 */
function buildIteratorRestBody(iterRecTypeIdx: number, vecTypeIdx: number, arrTypeIdx: number): Instr[] {
  return [
    // rec = cast(recExt)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
    { op: "local.tee", index: 1 },
    // vec = rec.vec
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 2 },
    // i = rec.idx
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 3 },
    // len = (vec == null) ? 0 : vec.length
    { op: "local.get", index: 2 },
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      ],
    } as unknown as Instr,
    { op: "local.set", index: 4 },
    // out = new externref[ (i < len) ? len - i : 0 ]   (clamp negative to 0).
    // Compute the count cleanly: the if's condition (i < len) is the ONLY value
    // on the stack entering the `if`, and each arm leaves exactly one i32.
    { op: "local.get", index: 3 },
    { op: "local.get", index: 4 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: 4 }, { op: "local.get", index: 3 }, { op: "i32.sub" }],
      else: [{ op: "i32.const", value: 0 }],
    } as unknown as Instr,
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: 5 },
    // j = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 6 },
    // while (i < len) { out[j] = vec.data[i]; i++; j++; }
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // i >= len -> break
            { op: "local.get", index: 3 },
            { op: "local.get", index: 4 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // out[j] = vec.data[i]
            { op: "local.get", index: 5 },
            { op: "ref.as_non_null" } as Instr,
            { op: "local.get", index: 6 },
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" } as Instr,
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: 3 },
            { op: "array.get", typeIdx: arrTypeIdx },
            { op: "array.set", typeIdx: arrTypeIdx } as Instr,
            // i++ ; j++
            { op: "local.get", index: 3 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 3 },
            { op: "local.get", index: 6 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 6 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // result vec = $vecExtern{ length: j, data: out }
    { op: "local.get", index: 6 },
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" } as Instr,
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" } as Instr,
  ];
}
