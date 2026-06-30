// (#2867 Gap 4) Native, host-free `Promise.all` / `Promise.race` combinators.
//
// Under the native-`$Promise` carrier (`isStandalonePromiseActive`, today
// `--target wasi`; widens to `--target standalone` at the #2895 slice-1d gate),
// `Promise.all([...])` / `Promise.race([...])` must NOT leak the `Promise_all` /
// `Promise_race` host imports (unsatisfiable with no JS host). This module emits
// the combinators directly on the existing carrier substrate
// (`async-scheduler.ts`): the `$Promise` struct, the `$PromiseCallback` reaction
// node, the microtask ring, and the one-shot `__promise_fulfill`/`__promise_reject`
// settle helpers. It forks NOTHING — it composes the same primitives the native
// `.then` machinery and the #2895 async drive layer already use.
//
// Scope (this slice): the **array-literal** argument form — `Promise.all([a, b])`
// — which is the dominant test262 shape and statically gives the element count.
// Non-literal iterables (`Promise.all(genericIterable)`) and the `allSettled` /
// `any` combinators (which additionally need per-element status objects /
// `AggregateError`) fall through to the existing host path and are follow-ups.
//
// **Inert until the widen.** Every emission site is gated on
// `isStandalonePromiseActive(ctx)`, which is `ctx.wasi`-only today, so the
// default gc/host lane AND the still-host-backed `--target standalone` lane are
// byte-identical. The combinator becomes live for standalone only when slice 1d
// widens the carrier gate (together with all other carrier gaps), never piecemeal
// (the AG0 −31 / #2367-graveyard lesson).

import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { allocLocal } from "./context/locals.js";
import {
  ensureAsyncDriveRuntime,
  getOrRegisterPromiseType,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_PENDING,
  PROMISE_STATE_REJECTED,
} from "./async-scheduler.js";

const EXTERNREF: ValType = { kind: "externref" };

type AsyncDriveRuntimeT = ReturnType<typeof ensureAsyncDriveRuntime>;

/** The combinators this module lowers natively. `allSettled`/`any` are deferred. */
export type NativeCombinator = "all" | "race";

export function isNativeCombinatorMethod(method: string): method is NativeCombinator {
  return method === "all" || method === "race";
}

interface CombinatorRuntime {
  /** `$CombinatorState { resultPromise: ref $Promise, resultsArr: ref $arr_ext, length: i32, remaining (mut) i32 }`. */
  stateTypeIdx: number;
  /** `$CombinatorElemCaps { state: ref $CombinatorState, index: i32 }`. */
  elemCapsTypeIdx: number;
  /** `$Promise` struct typeIdx. */
  promiseTypeIdx: number;
  /** externref vec struct typeIdx (the `Promise.all` result array wrapper). */
  vecTypeIdx: number;
  /** backing externref array typeIdx (inside the vec). */
  arrTypeIdx: number;
  /** `__combinator_subscribe(input, state, index, fulfillFn, rejectFn) -> void`. */
  subscribeFuncIdx: number;
  /** `__combinator_all_fulfill(caps, value) -> value`. */
  allFulfillFuncIdx: number;
  /** `__combinator_race_fulfill(caps, value) -> value`. */
  raceFulfillFuncIdx: number;
  /** `__combinator_reject(caps, reason) -> reason` (shared all/race). */
  rejectFuncIdx: number;
}

type CtxWithCombinators = CodegenContext & { __promiseCombinators?: CombinatorRuntime };

function registerStruct(
  ctx: CodegenContext,
  name: string,
  fields: { name: string; type: ValType; mutable: boolean }[],
): number {
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name, fields });
  // Mirror the bookkeeping $Promise does so the verifier/walker resolve by name.
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(
    name,
    fields.map((f) => ({ name: f.name, type: f.type, mutable: f.mutable })),
  );
  return typeIdx;
}

/**
 * Idempotently register the combinator state/caps struct types and the four
 * shared runtime helpers, reserving their funcIdx slots up-front (the generator
 * slot-reservation discipline — a late funcIdx assignment would shift the
 * indices the call-site `ref.func`s bake in; #1677/#1809/#1899).
 */
export function ensureCombinatorFunctions(ctx: CodegenContext): CombinatorRuntime {
  const cached = (ctx as CtxWithCombinators).__promiseCombinators;
  if (cached) return cached;

  // The async-drive runtime (Promise type, reaction node, microtask ring, settle
  // helpers) MUST be registered first — it appends functions, which would shift
  // our reserved slots if done after. ensureAsyncDriveRuntime is idempotent.
  const rt = ensureAsyncDriveRuntime(ctx);
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  const stateTypeIdx = registerStruct(ctx, "$CombinatorState", [
    { name: "resultPromise", type: { kind: "ref", typeIdx: promiseTypeIdx }, mutable: false },
    { name: "resultsArr", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: false },
    { name: "length", type: { kind: "i32" }, mutable: false },
    { name: "remaining", type: { kind: "i32" }, mutable: true },
  ]);
  const elemCapsTypeIdx = registerStruct(ctx, "$CombinatorElemCaps", [
    { name: "state", type: { kind: "ref", typeIdx: stateTypeIdx }, mutable: false },
    { name: "index", type: { kind: "i32" }, mutable: false },
  ]);

  // Func types. The fulfill/reject wrappers share the microtask wrapper shape
  // `(caps externref, value externref) -> externref` (addFuncType dedups, so this
  // resolves to the existing `$__mt_func_type`). subscribe is void-returning.
  const wrapperTypeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const subscribeTypeIdx = addFuncType(
    ctx,
    [EXTERNREF, EXTERNREF, { kind: "i32" }, { kind: "funcref" }, { kind: "funcref" }],
    [],
  );

  const base = ctx.numImportFuncs + ctx.mod.functions.length;
  const subscribeFuncIdx = base;
  const allFulfillFuncIdx = base + 1;
  const raceFulfillFuncIdx = base + 2;
  const rejectFuncIdx = base + 3;

  const ids: CombinatorRuntime = {
    stateTypeIdx,
    elemCapsTypeIdx,
    promiseTypeIdx,
    vecTypeIdx,
    arrTypeIdx,
    subscribeFuncIdx,
    allFulfillFuncIdx,
    raceFulfillFuncIdx,
    rejectFuncIdx,
  };

  ctx.mod.functions.push({
    name: "__combinator_subscribe",
    typeIdx: subscribeTypeIdx,
    locals: buildSubscribeLocals(promiseTypeIdx),
    body: buildSubscribeBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_subscribe", subscribeFuncIdx);

  ctx.mod.functions.push({
    name: "__combinator_all_fulfill",
    typeIdx: wrapperTypeIdx,
    locals: buildAllFulfillLocals(ids),
    body: buildAllFulfillBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_all_fulfill", allFulfillFuncIdx);

  ctx.mod.functions.push({
    name: "__combinator_race_fulfill",
    typeIdx: wrapperTypeIdx,
    locals: buildSettleWrapperLocals(ids),
    body: buildRaceFulfillBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_race_fulfill", raceFulfillFuncIdx);

  ctx.mod.functions.push({
    name: "__combinator_reject",
    typeIdx: wrapperTypeIdx,
    locals: buildSettleWrapperLocals(ids),
    body: buildRejectBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_reject", rejectFuncIdx);

  (ctx as CtxWithCombinators).__promiseCombinators = ids;
  return ids;
}

// ── __combinator_subscribe ───────────────────────────────────────────────────
// params: 0 input externref, 1 state externref, 2 index i32, 3 fulfillFn funcref,
//         4 rejectFn funcref. locals: 5 p (ref $Promise), 6 caps externref.

function buildSubscribeLocals(promiseTypeIdx: number): LocalDef[] {
  return [
    { name: "$p", type: { kind: "ref", typeIdx: promiseTypeIdx } },
    { name: "$caps", type: EXTERNREF },
  ];
}

function buildSubscribeBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT): Instr[] {
  const INPUT = 0;
  const STATE = 1;
  const INDEX = 2;
  const FULFILL_FN = 3;
  const REJECT_FN = 4;
  const P = 5;
  const CAPS = 6;
  const cbTypeIdx = rt.callbackTypeIdx;
  return [
    // Normalize `input` to a `$Promise`. A native `$Promise` passes through; any
    // other value is wrapped in a synchronously-FULFILLED `$Promise` so the
    // dispatch below is uniform (mirrors spec PromiseResolve for a non-thenable).
    { op: "local.get", index: INPUT },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ids.promiseTypeIdx } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: INPUT },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ids.promiseTypeIdx } as Instr,
        { op: "local.set", index: P },
      ],
      else: [
        { op: "i32.const", value: PROMISE_STATE_FULFILLED },
        { op: "local.get", index: INPUT },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: ids.promiseTypeIdx } as Instr,
        { op: "local.set", index: P },
      ],
    } as Instr,

    // caps = $CombinatorElemCaps{ state, index } (boxed to externref).
    { op: "local.get", index: STATE },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.stateTypeIdx } as Instr,
    { op: "local.get", index: INDEX },
    { op: "struct.new", typeIdx: ids.elemCapsTypeIdx } as Instr,
    { op: "extern.convert_any" },
    { op: "local.set", index: CAPS },

    // Dispatch on the (possibly already-settled) promise state.
    { op: "local.get", index: P },
    { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 0 } as Instr,
    { op: "i32.const", value: PROMISE_STATE_FULFILLED },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // enqueue(fulfillFn, caps, p.value)
        { op: "local.get", index: FULFILL_FN },
        { op: "local.get", index: CAPS },
        { op: "local.get", index: P },
        { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 1 } as Instr,
        { op: "call", funcIdx: rt.enqueueFuncIdx },
      ],
      else: [
        { op: "local.get", index: P },
        { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 0 } as Instr,
        { op: "i32.const", value: PROMISE_STATE_REJECTED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // enqueue(rejectFn, caps, p.value)
            { op: "local.get", index: REJECT_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: P },
            { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 1 } as Instr,
            { op: "call", funcIdx: rt.enqueueFuncIdx },
          ],
          else: [
            // pending: prepend a reaction node onto p.callbacks.
            { op: "local.get", index: P },
            { op: "local.get", index: FULFILL_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: REJECT_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: P },
            { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 2 } as Instr,
            { op: "struct.new", typeIdx: cbTypeIdx } as Instr,
            { op: "extern.convert_any" },
            { op: "struct.set", typeIdx: ids.promiseTypeIdx, fieldIdx: 2 } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
  ];
}

// ── __combinator_all_fulfill ─────────────────────────────────────────────────
// params: 0 caps externref, 1 value externref.
// locals: 2 c (ref $CombinatorElemCaps), 3 st (ref $CombinatorState), 4 rem i32.

function buildAllFulfillLocals(ids: CombinatorRuntime): LocalDef[] {
  return [
    { name: "$c", type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx } },
    { name: "$st", type: { kind: "ref", typeIdx: ids.stateTypeIdx } },
    { name: "$rem", type: { kind: "i32" } },
  ];
}

function buildAllFulfillBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT): Instr[] {
  const CAPS = 0;
  const VALUE = 1;
  const C = 2;
  const ST = 3;
  const REM = 4;
  return [
    { op: "local.get", index: CAPS },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx } as Instr,
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: ST },

    // results[index] = value
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.get", index: VALUE },
    { op: "array.set", typeIdx: ids.arrTypeIdx } as Instr,

    // remaining -= 1
    { op: "local.get", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 3 } as Instr,
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.tee", index: REM },
    { op: "struct.set", typeIdx: ids.stateTypeIdx, fieldIdx: 3 } as Instr,

    // if remaining == 0: fulfill the result promise with the results vec.
    { op: "local.get", index: REM },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 } as Instr,
        // vec = struct.new $vec(length, resultsArr)
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 2 } as Instr,
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 } as Instr,
        { op: "struct.new", typeIdx: ids.vecTypeIdx } as Instr,
        { op: "extern.convert_any" },
        { op: "call", funcIdx: rt.fulfillFuncIdx },
        { op: "drop" },
      ],
    } as Instr,

    { op: "local.get", index: VALUE },
  ];
}

// ── __combinator_race_fulfill / __combinator_reject ──────────────────────────
// params: 0 caps externref, 1 value externref. locals: 2 c, 3 st.

function buildSettleWrapperLocals(ids: CombinatorRuntime): LocalDef[] {
  return [
    { name: "$c", type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx } },
    { name: "$st", type: { kind: "ref", typeIdx: ids.stateTypeIdx } },
  ];
}

function buildSettleResultBody(ids: CombinatorRuntime, settleFuncIdx: number): Instr[] {
  const CAPS = 0;
  const VALUE = 1;
  const C = 2;
  const ST = 3;
  // Settle (fulfill for race, reject for both all & race) the shared result
  // promise with `value`. Settlement is one-shot, so a second settle no-ops —
  // exactly the "first wins" (race) / "first rejection wins" (all) semantics.
  return [
    { op: "local.get", index: CAPS },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx } as Instr,
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.get", index: VALUE },
    { op: "call", funcIdx: settleFuncIdx },
    // __promise_fulfill/__promise_reject return the settled value — that is the
    // wrapper's externref result, so leave it on the stack.
  ];
}

function buildRaceFulfillBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT): Instr[] {
  return buildSettleResultBody(ids, rt.fulfillFuncIdx);
}

function buildRejectBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT): Instr[] {
  return buildSettleResultBody(ids, rt.rejectFuncIdx);
}

/**
 * Emit a native `Promise.all([...])` / `Promise.race([...])`. `elementInstrs` is
 * the pre-compiled list of element expressions (each already coerced to
 * externref). Leaves the aggregate result `$Promise` on the stack as externref.
 */
export function emitStandalonePromiseCombinator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: NativeCombinator,
  elementInstrs: Instr[][],
): ValType {
  const ids = ensureCombinatorFunctions(ctx);
  const rt = ensureAsyncDriveRuntime(ctx);
  const n = elementInstrs.length;

  const resultLocal = allocLocal(fctx, `__comb_result_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.promiseTypeIdx,
  });
  const arrLocal = allocLocal(fctx, `__comb_arr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.arrTypeIdx,
  });
  const stateLocal = allocLocal(fctx, `__comb_state_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.stateTypeIdx,
  });

  // Pending result promise.
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: ids.promiseTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Backing results array (only meaningful for `all`; `race` ignores it).
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "array.new_default", typeIdx: ids.arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // $CombinatorState{ resultPromise, resultsArr, length=n, remaining=n }.
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "struct.new", typeIdx: ids.stateTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: stateLocal });

  if (n === 0) {
    // `Promise.all([])` fulfills immediately with an empty array. `Promise.race([])`
    // stays pending forever (spec) — emit nothing.
    if (method === "all") {
      fctx.body.push({ op: "local.get", index: resultLocal });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "struct.new", typeIdx: ids.vecTypeIdx } as Instr);
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "call", funcIdx: rt.fulfillFuncIdx });
      fctx.body.push({ op: "drop" });
    }
  } else {
    const fulfillFn = method === "all" ? ids.allFulfillFuncIdx : ids.raceFulfillFuncIdx;
    for (let i = 0; i < n; i++) {
      for (const instr of elementInstrs[i]!) fctx.body.push(instr);
      fctx.body.push({ op: "local.get", index: stateLocal });
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "ref.func", funcIdx: fulfillFn } as Instr);
      fctx.body.push({ op: "ref.func", funcIdx: ids.rejectFuncIdx } as Instr);
      fctx.body.push({ op: "call", funcIdx: ids.subscribeFuncIdx });
    }
  }

  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "extern.convert_any" });
  return EXTERNREF;
}
