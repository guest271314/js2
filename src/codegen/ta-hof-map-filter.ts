// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2903 R4b) Native standalone TypedArray `map`/`filter` — the typed-RESULT
// callback HOFs. R4 (the scalar HOFs) routed find/forEach/some/every/reduce
// through the generic `__hof_*` loop (whose result is a scalar or an $ObjVec).
// `map`/`filter` differ: they must return a NEW TypedArray of the SAME element
// kind (§23.2.3.19 / §23.2.3.9), so the result needs a freshly-allocated packed
// `$__vec_<kind>` carrier with per-element width-wrapping — which the generic
// `$ObjVec`-returning loop cannot produce.
//
// These helpers allocate the packed result carrier and drive the callback via
// the same host-free `__apply_closure` bridge R4 uses (NO `env.__make_callback`).
// The callback result (map) / the element (filter, when the predicate is truthy)
// is written with `i32.trunc_sat_f64_s` + a packed `array.set`, which masks to
// the element width — that is exactly JS `ToInt8`/`ToUint8`/`ToInt16`/… (the
// stored bits are identical for a signed vs unsigned view of the same width;
// they differ only on READ, which the static-typed result binding handles with
// the correct `array.get_s`/`_u`). `filter` is SINGLE-PASS (the predicate runs
// exactly once per element, §23.2.3.9 step 6): it over-allocates a length-`len`
// backing array, fills the first `k` kept slots, and returns a vec whose LENGTH
// field is `k` (the tail capacity is unused — reads honor the length field).
//
// SCOPE (bounded): keyed by the packed vec STRUCT type, so one helper serves
// every view sharing a carrier (Int8/Uint8 share `i8_byte` — the store is
// identical). `Uint8ClampedArray` is deliberately NOT routed here (it shares the
// `i8_byte` carrier but needs round-half-to-even clamping, not truncation — a
// follow-up), and neither is the `any`-held receiver (runtime carrier-kind
// dispatch — a follow-up). The caller (`expressions/calls.ts`) gates on those.
// Standalone-only; gc/host keep the existing host path (byte-identical).
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";

/**
 * Ensure the native `map`/`filter` helper for the packed vec struct `vecTypeIdx`
 * exists; return its funcIdx (or `undefined` if a required runtime dep is
 * missing or the struct is not a `{ length, data:(ref $arr) }` packed carrier).
 *
 * Signature: `(recv externref, cb externref, thisArg externref) -> (ref $vec)`.
 * Idempotent (funcMap-cached by name). Standalone-only.
 */
export function ensureTaMapFilterHelper(
  ctx: CodegenContext,
  methodName: "map" | "filter",
  vecTypeIdx: number,
): number | undefined {
  if (!ctx.standalone) return undefined;
  const helperName = `__ta_${methodName}_${vecTypeIdx}`;
  const cached = ctx.funcMap.get(helperName);
  if (cached !== undefined) return cached;

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return undefined;

  // Register runtime deps (append-only defined funcs — no funcIdx shift). Same
  // set + discipline as `ensureNativeArrayHof` (#3098): the loop reads through
  // R4's byte-carrier-aware `__extern_get_idx` / `__extern_length` and invokes
  // the closure via `__apply_closure`.
  ensureObjectRuntime(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  if (
    externLengthIdx === undefined ||
    externGetIdxIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    boxNumIdx === undefined ||
    unboxNumIdx === undefined ||
    isTruthyIdx === undefined
  ) {
    return undefined; // defensive — all registered by ensureObjectRuntime above
  }

  const isFilter = methodName === "filter";
  // params: 0=recv 1=cb 2=thisArg
  const RECV = 0;
  const CB = 1;
  const THIS = 2;
  // locals (all after the 3 params):
  const LEN = 3; // i32
  const I = 4; // i32
  const K = 5; // i32 (filter kept-count / map unused)
  const DATA = 6; // ref $arr
  const ARGS = 7; // externref ($ObjVec)
  const RES = 8; // externref (callback result)
  const ELEM = 9; // externref (boxed element)

  // fidx(i) → f64 index for the externref indexers.
  const fIdx: Instr[] = [{ op: "local.get", index: I } as Instr, { op: "f64.convert_i32_s" } as Instr];

  // elem = __extern_get_idx(recv, f64(i))
  const readElem: Instr[] = [
    { op: "local.get", index: RECV } as Instr,
    ...fIdx,
    { op: "call", funcIdx: externGetIdxIdx } as Instr,
    { op: "local.set", index: ELEM } as Instr,
  ];
  // args = __objvec_new(); push(elem); push(box(f64 i)); push(recv)
  const buildArgs: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx } as Instr,
    { op: "local.set", index: ARGS } as Instr,
    { op: "local.get", index: ARGS } as Instr,
    { op: "local.get", index: ELEM } as Instr,
    { op: "call", funcIdx: objVecPushIdx } as Instr,
    { op: "local.get", index: ARGS } as Instr,
    ...fIdx,
    { op: "call", funcIdx: boxNumIdx } as Instr,
    { op: "call", funcIdx: objVecPushIdx } as Instr,
    { op: "local.get", index: ARGS } as Instr,
    { op: "local.get", index: RECV } as Instr,
    { op: "call", funcIdx: objVecPushIdx } as Instr,
  ];
  // res = __apply_closure(cb, thisArg, args)
  const invoke: Instr[] = [
    { op: "local.get", index: CB } as Instr,
    { op: "local.get", index: THIS } as Instr,
    { op: "local.get", index: ARGS } as Instr,
    { op: "call", funcIdx: applyClosureIdx } as Instr,
    { op: "local.set", index: RES } as Instr,
  ];

  // The value to STORE: map → the callback result; filter → the element itself.
  const storeSourceUnbox: Instr[] = isFilter
    ? [{ op: "local.get", index: ELEM } as Instr, { op: "call", funcIdx: unboxNumIdx } as Instr]
    : [{ op: "local.get", index: RES } as Instr, { op: "call", funcIdx: unboxNumIdx } as Instr];

  // data[dst] = trunc_sat_f64_s(unbox(source))   (packed array.set masks to width)
  const writeAt = (dstLocal: number): Instr[] => [
    { op: "local.get", index: DATA } as Instr,
    { op: "local.get", index: dstLocal } as Instr,
    ...storeSourceUnbox,
    { op: "i32.trunc_sat_f64_s" } as Instr,
    { op: "array.set", typeIdx: arrTypeIdx } as Instr,
  ];

  // Per-iteration body.
  let perIter: Instr[];
  if (isFilter) {
    perIter = [
      ...readElem,
      ...buildArgs,
      ...invoke,
      // if (__is_truthy(res)) { data[k] = elem; k++ }
      { op: "local.get", index: RES } as Instr,
      { op: "call", funcIdx: isTruthyIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...writeAt(K),
          { op: "local.get", index: K } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.add" } as Instr,
          { op: "local.set", index: K } as Instr,
        ],
      } as Instr,
    ];
  } else {
    perIter = [...readElem, ...buildArgs, ...invoke, ...writeAt(I)];
  }

  // len = trunc_sat(__extern_length(recv)) ; data = array.new_default(len)
  const body: Instr[] = [
    { op: "local.get", index: RECV } as Instr,
    { op: "call", funcIdx: externLengthIdx } as Instr,
    { op: "i32.trunc_sat_f64_s" } as Instr,
    { op: "local.tee", index: LEN } as Instr,
    { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: DATA } as Instr,
    // i = 0 ; k = 0
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: I } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: K } as Instr,
    // loop while i < len
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I } as Instr,
            { op: "local.get", index: LEN } as Instr,
            { op: "i32.ge_s" } as Instr,
            { op: "br_if", depth: 1 } as Instr,
            ...perIter,
            // i++
            { op: "local.get", index: I } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "local.set", index: I } as Instr,
            { op: "br", depth: 0 } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
    // return struct.new $vec (length = map:len / filter:k, data)
    { op: "local.get", index: isFilter ? K : LEN } as Instr,
    { op: "local.get", index: DATA } as Instr,
    { op: "struct.new", typeIdx: vecTypeIdx } as Instr,
  ];

  const params: ValType[] = [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }];
  const typeIdx = addFuncType(ctx, params, [{ kind: "ref", typeIdx: vecTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);
  const locals: { name: string; type: ValType }[] = [
    { name: "len", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "k", type: { kind: "i32" } },
    { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx } },
    { name: "args", type: { kind: "externref" } },
    { name: "res", type: { kind: "externref" } },
    { name: "elem", type: { kind: "externref" } },
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}
