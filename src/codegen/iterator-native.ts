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
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";

/** Slice-1 IterRec kind tag for a canonical externref `$Vec`. */
const ITER_KIND_VEC = 3;

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

  const fields = [
    { name: "kind", type: { kind: "i32" as const }, mutable: false },
    { name: "vec", type: { kind: "ref_null" as const, typeIdx: vecTypeIdx }, mutable: false },
    { name: "idx", type: { kind: "i32" as const }, mutable: true },
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
  // GetIterator §7.4.1. Slice 1: `obj` is an externref-wrapped canonical
  // externref `$Vec`. Unwrap → build $IterRec{kind:3, vec, idx:0} → rewrap.
  // local 0 = obj (param, externref)
  registerNative(
    "__iterator",
    [{ kind: "externref" }],
    [{ kind: "externref" }],
    [],
    [
      { op: "i32.const", value: ITER_KIND_VEC },
      // vec = ref.cast<$vecExtern>(any.convert_extern(obj))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast", typeIdx: vecTypeIdx },
      { op: "i32.const", value: 0 },
      { op: "struct.new", typeIdx: iterRecTypeIdx },
      { op: "extern.convert_any" } as Instr,
    ],
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
    ],
    buildIteratorNextBody(iterRecTypeIdx, vecTypeIdx, arrTypeIdx),
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
 * Locals: 0=recExt(param), 1=rec, 2=vec, 3=i, 4=done(i32), 5=value(externref).
 */
function buildIteratorNextBody(iterRecTypeIdx: number, vecTypeIdx: number, arrTypeIdx: number): Instr[] {
  return [
    // rec = cast(any.convert_extern(recExt))
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
        // value = vec.data[i]
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 3 },
        { op: "array.get", typeIdx: arrTypeIdx },
        { op: "local.set", index: 5 },
        // rec.idx = i + 1
        { op: "local.get", index: 1 },
        { op: "local.get", index: 3 },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx: iterRecTypeIdx, fieldIdx: 2 } as Instr,
      ],
      else: [],
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
