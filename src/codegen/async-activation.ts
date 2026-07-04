// (#2957 phase 1) Shared async state-machine activation entry point.
//
// The async/await CPS + drive activation logic was previously inlined inside
// `compileFunctionBody` and gated on `ts.isFunctionDeclaration`, so it was
// unreachable from the arrow (`closures.ts`), class-method (`class-bodies.ts`)
// and object-literal-method (`literals.ts`) body-compile paths — those shapes
// silently fell through to the legacy synchronous pass-through and never
// activated a state machine (#2957 root-cause).
//
// This module factors that block into a single reusable
// `maybeActivateAsync(ctx, fctx, decl, func)` helper. Phase 1 is a **pure,
// byte-inert extraction**: `compileFunctionBody` calls it and the internal
// `ts.isFunctionDeclaration` guards are preserved verbatim, so no shape's
// emitted bytes change. Phases 2–3 wire the same entry point into the three
// other body-compile paths (the real behaviour change) and, at that point,
// relax the declaration guards.

import { ts } from "../ts-api.js";
import type { ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { ASYNC_CPS_ENABLED, analyzeAsyncBody, asyncFnNeedsCps, emitAsyncStateMachine } from "./async-cps.js";
import { emitAsyncFrameStateMachine, asyncFnNeedsDrive, asyncFnNeedsHostDrive } from "./async-frame.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";

/**
 * Rewrite a compiled function's registered result type. An activated async
 * function returns a real Promise object (externref), not the unwrapped value.
 */
function rewriteFuncResultType(ctx: CodegenContext, func: WasmFunction, result: ValType): void {
  const ft = ctx.mod.types[func.typeIdx];
  if (!ft || ft.kind !== "func") return;
  func.typeIdx = addFuncType(ctx, ft.params.slice(), [result]);
}

/**
 * Decide whether `decl` should be lowered to an async state machine, and if so
 * emit it (rewriting the result type to externref and emitting the frame/CPS
 * body). Returns `true` when the async machine was emitted — in which case the
 * caller MUST skip its normal statement-compilation loop, because this helper
 * has already produced the full function body.
 *
 * Byte-inert extraction of the two activation blocks from
 * `compileFunctionBody` (#2957 phase 1). The `ts.isFunctionDeclaration` guards
 * are intentionally preserved: phase 1 changes no shape's behaviour. The `decl`
 * parameter is typed as `ts.FunctionLikeDeclaration` so phases 2–3 can call
 * this from the arrow/method paths without a signature change.
 */
export function maybeActivateAsync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionLikeDeclaration,
  func: WasmFunction,
): boolean {
  const isAsync = ctx.asyncFunctions.has(func.name);

  let asyncCpsHandled = false;
  // (#2895 PATH B) Host-free async drive layer. Gated on the native-`$Promise`
  // *carrier* (`isStandalonePromiseActive`, currently `wasi`-only): when the
  // awaited operand resolves to a native `$Promise`, a genuinely-suspending
  // async fn is driven by a real resumable `$AsyncFrame` (await → spill +
  // reaction + return result-promise; microtask drain resumes). Gating the
  // wiring on the carrier predicate makes the standalone re-widen (#2895 1d)
  // flip the carrier AND the drive layer together — exactly the AG0-safe
  // coupling. The result is a real `$Promise` (externref), not a sync value.
  if (ASYNC_CPS_ENABLED && isAsync && isStandalonePromiseActive(ctx) && ts.isFunctionDeclaration(decl) && decl.body) {
    const asyncPlan = analyzeAsyncBody(ctx, decl);
    // (#2906) Drive-layer eligibility now accepts linear MULTI-await bodies,
    // not just the single canonical await `asyncFnNeedsCps` gates on. For a
    // single await the verdict is identical, so wasi single-await routing is
    // unchanged; ≥2 sequential awaits (previously demoted to the AG0 unwrap)
    // now get the general N-state resume machine.
    if (asyncFnNeedsDrive(ctx, decl, asyncPlan)) {
      rewriteFuncResultType(ctx, func, { kind: "externref" });
      fctx.returnType = { kind: "externref" };
      emitAsyncFrameStateMachine(ctx, fctx, decl, asyncPlan);
      asyncCpsHandled = true;
    }
  }
  if (
    !asyncCpsHandled &&
    ASYNC_CPS_ENABLED &&
    isAsync &&
    !ctx.wasi &&
    !ctx.standalone &&
    ts.isFunctionDeclaration(decl) &&
    decl.body
  ) {
    const asyncPlan = analyzeAsyncBody(ctx, decl);
    if (asyncFnNeedsCps(decl, asyncPlan)) {
      // The async function returns a Promise object (externref), not the
      // unwrapped value. Rewrite the registered signature's result + fctx.
      rewriteFuncResultType(ctx, func, { kind: "externref" });
      fctx.returnType = { kind: "externref" };
      fctx.asyncCpsActive = true;
      emitAsyncStateMachine(ctx, fctx, decl, asyncPlan);
      asyncCpsHandled = true;
    } else if (asyncFnNeedsHostDrive(ctx, decl, asyncPlan)) {
      // (#1042 July re-scope) JS-host lane onto the #2906 N-state resume
      // machine with HOST-Promise settle adapters. Claims only the linear
      // shapes the single-tail-await CPS lane rejects (multi-await,
      // try/finally-across-await) — those previously fell through to the
      // legacy synchronous fakery and returned wrong values under genuine
      // suspension. Same externref result contract as the CPS lane.
      rewriteFuncResultType(ctx, func, { kind: "externref" });
      fctx.returnType = { kind: "externref" };
      emitAsyncFrameStateMachine(ctx, fctx, decl, asyncPlan, /*host*/ true);
      asyncCpsHandled = true;
    }
  }

  return asyncCpsHandled;
}
