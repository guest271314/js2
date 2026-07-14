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
// identical). `Uint8ClampedArray` (#2903 R4c) ALSO shares the `i8_byte` carrier
// but needs round-half-to-even CLAMP (§7.1.11 ToUint8Clamp), not truncation, so
// it is served by a DISTINCT helper name (`__ta_<m>_clamp_<idx>`) via the `clamp`
// param below. The `any`-held receiver (runtime carrier-kind dispatch) remains a
// follow-up; the caller (`expressions/calls.ts`) gates on that.
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
 *
 * `clamp` (#2903 R4c) selects the STORE conversion for the `Uint8ClampedArray`
 * view: instead of the `i32.trunc_sat_f64_s` width-truncation every other packed
 * integer view uses, the callback result is stored via `ToUint8Clamp` (§7.1.11 —
 * NaN→0, ≤0→0, ≥255→255, else round-HALF-TO-EVEN). `Uint8ClampedArray` shares the
 * `i8_byte` carrier (⇒ same `vecTypeIdx`) with `Int8Array`/`Uint8Array`, so the
 * clamp variant MUST live under a DISTINCT name (`__ta_<m>_clamp_<idx>`) to avoid
 * colliding with the truncating helper for the same carrier.
 */
export function ensureTaMapFilterHelper(
  ctx: CodegenContext,
  methodName: "map" | "filter",
  vecTypeIdx: number,
  clamp = false,
): number | undefined {
  if (!ctx.standalone) return undefined;
  const helperName = clamp ? `__ta_${methodName}_clamp_${vecTypeIdx}` : `__ta_${methodName}_${vecTypeIdx}`;
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
  // (#2903 R4c) ToUint8Clamp scratch (only allocated/used when `clamp`):
  const CX = 10; // f64 — the value being clamped
  const CF = 11; // f64 — floor(x)
  const CD = 12; // f64 — x - floor(x) / f/2 scratch
  const COUT = 13; // i32 — clamped result

  // fidx(i) → f64 index for the externref indexers.
  const fIdx: Instr[] = [{ op: "local.get", index: I }, { op: "f64.convert_i32_s" }];

  // elem = __extern_get_idx(recv, f64(i))
  const readElem: Instr[] = [
    { op: "local.get", index: RECV },
    ...fIdx,
    { op: "call", funcIdx: externGetIdxIdx },
    { op: "local.set", index: ELEM },
  ];
  // args = __objvec_new(); push(elem); push(box(f64 i)); push(recv)
  const buildArgs: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: ARGS },
    { op: "local.get", index: ARGS },
    { op: "local.get", index: ELEM },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: ARGS },
    ...fIdx,
    { op: "call", funcIdx: boxNumIdx },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: ARGS },
    { op: "local.get", index: RECV },
    { op: "call", funcIdx: objVecPushIdx },
  ];
  // res = __apply_closure(cb, thisArg, args)
  const invoke: Instr[] = [
    { op: "local.get", index: CB },
    { op: "local.get", index: THIS },
    { op: "local.get", index: ARGS },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "local.set", index: RES },
  ];

  // The value to STORE: map → the callback result; filter → the element itself.
  const storeSourceUnbox: Instr[] = isFilter
    ? [
        { op: "local.get", index: ELEM },
        { op: "call", funcIdx: unboxNumIdx },
      ]
    : [
        { op: "local.get", index: RES },
        { op: "call", funcIdx: unboxNumIdx },
      ];

  // f64 (on stack) → the i32 to store. Default: `i32.trunc_sat_f64_s` (packed
  // `array.set` masks to element width = JS ToInt8/ToUint8/…). Clamp variant
  // (#2903 R4c): `ToUint8Clamp` (§7.1.11) — NaN→0, ≤0→0, ≥255→255, else round-
  // HALF-TO-EVEN. Mirrors `emitToUint8Clamp` (binary-ops.ts, #2593) with the
  // helper's own scratch locals; `roundHalfEven` only runs for 0<x<255 so its
  // final `i32.trunc_sat_f64_u` is exact.
  const roundHalfEven: Instr[] = [
    { op: "local.get", index: CX },
    { op: "f64.floor" },
    { op: "local.set", index: CF },
    { op: "local.get", index: CX },
    { op: "local.get", index: CF },
    { op: "f64.sub" },
    { op: "local.set", index: CD },
    { op: "local.get", index: CD },
    { op: "f64.const", value: 0.5 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } as ValType },
      then: [{ op: "local.get", index: CF }],
      else: [
        { op: "local.get", index: CD },
        { op: "f64.const", value: 0.5 },
        { op: "f64.gt" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } as ValType },
          then: [{ op: "local.get", index: CF }, { op: "f64.const", value: 1 }, { op: "f64.add" }],
          else: [
            // tie (d == 0.5): round to even. f even ⇔ floor(f/2) == f/2.
            { op: "local.get", index: CF },
            { op: "f64.const", value: 0.5 },
            { op: "f64.mul" },
            { op: "local.set", index: CD },
            { op: "local.get", index: CD },
            { op: "f64.floor" },
            { op: "local.get", index: CD },
            { op: "f64.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } as ValType },
              then: [{ op: "local.get", index: CF }],
              else: [{ op: "local.get", index: CF }, { op: "f64.const", value: 1 }, { op: "f64.add" }],
            },
          ],
        },
      ],
    },
    { op: "i32.trunc_sat_f64_u" },
    { op: "local.set", index: COUT },
  ];
  const clampToUint8: Instr[] = [
    { op: "local.set", index: CX },
    { op: "local.get", index: CX },
    { op: "f64.const", value: 255 },
    { op: "f64.ge" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 255 },
        { op: "local.set", index: COUT },
      ],
      else: [
        { op: "local.get", index: CX },
        { op: "f64.const", value: 0 },
        { op: "f64.gt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: roundHalfEven,
          else: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: COUT },
          ],
        },
      ],
    },
    { op: "local.get", index: COUT },
  ];
  const f64ToStore: Instr[] = clamp ? clampToUint8 : [{ op: "i32.trunc_sat_f64_s" }];

  // data[dst] = f64ToStore(unbox(source))   (packed array.set masks to width)
  const writeAt = (dstLocal: number): Instr[] => [
    { op: "local.get", index: DATA },
    { op: "local.get", index: dstLocal },
    ...storeSourceUnbox,
    ...f64ToStore,
    { op: "array.set", typeIdx: arrTypeIdx },
  ];

  // Per-iteration body.
  let perIter: Instr[];
  if (isFilter) {
    perIter = [
      ...readElem,
      ...buildArgs,
      ...invoke,
      // if (__is_truthy(res)) { data[k] = elem; k++ }
      { op: "local.get", index: RES },
      { op: "call", funcIdx: isTruthyIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...writeAt(K),
          { op: "local.get", index: K },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: K },
        ],
      },
    ];
  } else {
    perIter = [...readElem, ...buildArgs, ...invoke, ...writeAt(I)];
  }

  // len = trunc_sat(__extern_length(recv)) ; data = array.new_default(len)
  const body: Instr[] = [
    { op: "local.get", index: RECV },
    { op: "call", funcIdx: externLengthIdx },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: LEN },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: DATA },
    // i = 0 ; k = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: K },
    // loop while i < len
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...perIter,
            // i++
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // return struct.new $vec (length = map:len / filter:k, data)
    { op: "local.get", index: isFilter ? K : LEN },
    { op: "local.get", index: DATA },
    { op: "struct.new", typeIdx: vecTypeIdx },
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
  if (clamp) {
    // (#2903 R4c) ToUint8Clamp scratch (CX/CF/CD/COUT = indices 10..13). Always
    // append the full set so the local indices are stable regardless of method.
    locals.push(
      { name: "cx", type: { kind: "f64" } },
      { name: "cf", type: { kind: "f64" } },
      { name: "cd", type: { kind: "f64" } },
      { name: "cout", type: { kind: "i32" } },
    );
  }
  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}
