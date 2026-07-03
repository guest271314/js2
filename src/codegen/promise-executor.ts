// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2959 — native `new Promise(executor)` for standalone / WASI mode.
//
// Retires the unconditional `Promise_new` host import for the executor
// pattern. In standalone/WASI mode the whole Promise carrier is already
// native ($Promise struct, __promise_resolve_value assimilation,
// __promise_reject, microtask ring, native .then/.catch). The ONE remaining
// host leak was `new Promise((resolve, reject) => …)`, which always lowered
// to `call Promise_new`.
//
// This module synthesises the two capturing settle closures (`resolve` /
// `reject`) as WasmGC values the compiled executor body can invoke through
// its normal native `call_ref` dispatch, runs the executor synchronously
// (spec: the executor runs before `new Promise` returns), and rejects on an
// executor throw-before-settle.
//
// ABI (verified against current main, 2026-07-03):
//   - The executor arrow's `resolve` / `reject` parameters are BOTH externref
//     (a Promise-executor `resolve`/`reject` is always `(value) => void`, i.e.
//     the canonical `(externref) -> ()` closure signature — the `value` param
//     is `T | PromiseLike<T>` / `any`, which always resolves to externref).
//   - Inside the executor body a call `resolve(x)` lowers (in WASI mode) to:
//       any.convert_extern; ref.test (ref $wrap); [native] struct.get 0 ->
//       ref.cast $wrapFuncType -> call_ref ; [else] throw TypeError.
//     There is NO host `__call_function` fallback under WASI (that arm is
//     gated `!ctx.standalone && !ctx.wasi`). So a `resolve`/`reject` value
//     that IS a subtype of the canonical `(externref) -> ()` wrapper struct
//     dispatches natively; anything else throws. We therefore construct the
//     settle closures as subtypes of exactly that canonical wrapper struct,
//     with one extra immutable field carrying the captured `$Promise`.

import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { compileArrowAsClosure, getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { allocLocal } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureExnTag } from "./registry/imports.js";
import { coerceType, emitGuardedFuncRefCast, pushDefaultValue } from "./type-coercion.js";
import { emitNullCheckThrow } from "./property-access.js";
import {
  PROMISE_STATE_PENDING,
  ensurePromiseSettleFunctions,
  getOrRegisterPromiseType,
  isStandalonePromiseActive,
} from "./async-scheduler.js";

/**
 * Per-module cache of the two synthesised settle-closure funcs + the capturing
 * wrapper struct type. Minted once and reused for every `new Promise` in the
 * module, so the module carries a single `__promise_resolve_cl` /
 * `__promise_reject_cl` pair regardless of executor count.
 */
interface PromiseExecutorClosures {
  /** `__promise_resolve_cl` funcIdx — settles the captured promise via resolve-value (assimilating). */
  resolveClFuncIdx: number;
  /** `__promise_reject_cl` funcIdx — settles the captured promise via reject. */
  rejectClFuncIdx: number;
  /** The `$__promise_settle_cap` struct typeIdx (subtype of the canonical `(externref)->()` wrapper). */
  capTypeIdx: number;
  /** `$Promise` struct typeIdx. */
  promiseTypeIdx: number;
  /** `__promise_reject(promise, reason) -> reason` funcIdx (used by the executor-throw catch). */
  rejectFuncIdx: number;
}

/**
 * Idempotently mint the two capturing settle-closure trampolines and register
 * the `$__promise_settle_cap` wrapper subtype. Cached on the context.
 *
 * `$__promise_settle_cap` is a struct subtype of the canonical `(externref)->()`
 * func-ref wrapper (`getOrCreateFuncRefWrapperTypes(ctx,[externref],[])`), so a
 * value of this type passes the executor's `ref.test (ref $wrap)` and dispatches
 * natively. It inherits field 0 (`func: funcref`) and adds field 1
 * (`cap_promise: (ref $Promise)`).
 *
 * Each trampoline has EXACTLY the canonical lifted func type
 * (`(ref null $wrap, externref) -> ()`) so the executor's
 * `ref.cast (ref $wrapFuncType); call_ref` at the resolve/reject call site
 * succeeds; the body downcasts self to the `cap` subtype to recover the promise.
 */
function ensurePromiseExecutorClosures(ctx: CodegenContext): PromiseExecutorClosures | null {
  const cache = ctx as unknown as { __promiseExecutorClosures?: PromiseExecutorClosures };
  if (cache.__promiseExecutorClosures) return cache.__promiseExecutorClosures;

  ensurePromiseSettleFunctions(ctx);
  const resolveValueFuncIdx = ctx.funcMap.get("__promise_resolve_value");
  const rejectFuncIdx = ctx.funcMap.get("__promise_reject");
  if (resolveValueFuncIdx === undefined || rejectFuncIdx === undefined) return null;

  const promiseTypeIdx = getOrRegisterPromiseType(ctx);

  // Canonical `(externref) -> ()` wrapper — the SAME struct the executor body
  // ref.tests / ref.casts `resolve`/`reject` against (shared via the signature
  // cache). Our cap struct subtypes it so the native dispatch matches.
  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [{ kind: "externref" }], []);
  if (!wrapper) return null;

  const capTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__promise_settle_cap",
    fields: [
      // Field 0 is inherited from the wrapper root (funcref); it MUST be
      // redeclared identically in the subtype.
      { name: "func", type: { kind: "funcref" }, mutable: false },
      { name: "cap_promise", type: { kind: "ref", typeIdx: promiseTypeIdx }, mutable: false },
    ],
    superTypeIdx: wrapper.structTypeIdx,
  });

  // Mint both trampolines UP-FRONT (stable-regime handles) before any code
  // references them, mirroring ensurePromiseSettleFunctions' discipline.
  const resolveClFuncIdx = mintDefinedFunc(ctx);
  const rejectClFuncIdx = mintDefinedFunc(ctx);

  // Body: recover captured promise from self (downcast to the cap subtype),
  // then settle it with the incoming value. resolve routes through
  // __promise_resolve_value (assimilation: resolve(aPromise) chains); reject
  // routes through __promise_reject. The already-settled guard lives in the
  // settle helpers (buildPromiseSettleBody), so double-settle / settle-after-
  // throw is a spec-correct no-op by construction.
  const makeBody = (settleFuncIdx: number): Instr[] => [
    { op: "local.get", index: 0 }, // self: (ref null $wrap)
    { op: "ref.cast", typeIdx: capTypeIdx }, // downcast to the cap subtype (non-null)
    { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: 1 }, // captured (ref $Promise)
    { op: "local.get", index: 1 }, // value: externref
    { op: "call", funcIdx: settleFuncIdx }, // settle -> externref
    { op: "drop" }, // trampoline result type is () — discard the settled value
  ];

  pushDefinedFunc(ctx, resolveClFuncIdx, {
    name: "__promise_resolve_cl",
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [],
    body: makeBody(resolveValueFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__promise_resolve_cl", resolveClFuncIdx);

  pushDefinedFunc(ctx, rejectClFuncIdx, {
    name: "__promise_reject_cl",
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [],
    body: makeBody(rejectFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__promise_reject_cl", rejectClFuncIdx);

  const result: PromiseExecutorClosures = {
    resolveClFuncIdx,
    rejectClFuncIdx,
    capTypeIdx,
    promiseTypeIdx,
    rejectFuncIdx,
  };
  cache.__promiseExecutorClosures = result;
  return result;
}

/**
 * #2959 — Emit the native standalone `new Promise(executor)` lowering.
 *
 * Returns `true` when it emitted a native path (leaving an externref `$Promise`
 * on the stack); returns `false` — having emitted NOTHING — when the native
 * path is not applicable (host/gc mode, or a non-resolvable executor). The
 * caller must then fall through to the existing `Promise_new` host path.
 *
 * Native only under `isStandalonePromiseActive` (WASI today), so host/gc mode is
 * byte-unchanged. The executor must be a plain arrow / function expression whose
 * `ClosureInfo` we can recover; anything else returns `false` (host fallback) —
 * never a partial native path.
 */
export function emitStandalonePromiseFromExecutor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  executorArg: ts.Expression,
): boolean {
  if (!isStandalonePromiseActive(ctx)) return false;

  // Start narrow: inline arrow / (non-async, non-generator) function expression.
  // Widen to identifier-bound closures later. Anything else → host fallback.
  if (!(ts.isArrowFunction(executorArg) || ts.isFunctionExpression(executorArg))) return false;
  const isAsync = executorArg.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  if (isAsync) return false;
  if (ts.isFunctionExpression(executorArg) && executorArg.asteriskToken !== undefined) return false;

  // Ensure the exception tag exists BEFORE compiling the executor / minting the
  // trampolines, so no later tag/import registration perturbs indices mid-emit.
  const exnTag = ensureExnTag(ctx);

  // 1. Compile the executor into a scratch buffer and recover its ClosureInfo.
  //    Kept reachable to the late-import shifter via ctx.liveBodies + the
  //    savedBodies swap (mirrors compileStandalonePromiseThenCallback).
  const execInstrs: Instr[] = [];
  ctx.liveBodies.add(execInstrs);
  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);
  fctx.body = execInstrs;
  let closureInfo: ClosureInfo | undefined;
  try {
    const type = compileArrowAsClosure(ctx, fctx, executorArg);
    if (type && (type.kind === "ref" || type.kind === "ref_null")) {
      closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
    }
    // Normalise the scratch buffer to leave the executor closure as externref.
    if (type && type.kind !== "externref") {
      coerceType(ctx, fctx, type, { kind: "externref" });
    }
  } finally {
    fctx.savedBodies.pop();
    fctx.body = savedBody;
  }
  if (!closureInfo) {
    execInstrs.length = 0;
    ctx.liveBodies.delete(execInstrs);
    return false;
  }

  const closures = ensurePromiseExecutorClosures(ctx);
  if (!closures) {
    execInstrs.length = 0;
    ctx.liveBodies.delete(execInstrs);
    return false;
  }
  const { resolveClFuncIdx, rejectClFuncIdx, capTypeIdx, promiseTypeIdx, rejectFuncIdx } = closures;

  // 2. Allocate the pending $Promise: {state: PENDING, value: null, callbacks: null}.
  const pLocal = allocLocal(fctx, `__pexec_p_${fctx.locals.length}`, { kind: "ref", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: pLocal });

  // 3. Materialise resolve / reject as capturing closure VALUES (externref):
  //    struct{ func: ref.func $cl, cap_promise: p } upcast to externref.
  const emitSettleValue = (clFuncIdx: number, dst: number): void => {
    fctx.body.push({ op: "ref.func", funcIdx: clFuncIdx });
    fctx.body.push({ op: "local.get", index: pLocal });
    fctx.body.push({ op: "struct.new", typeIdx: capTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.set", index: dst });
  };
  const rvLocal = allocLocal(fctx, `__pexec_rv_${fctx.locals.length}`, { kind: "externref" });
  emitSettleValue(resolveClFuncIdx, rvLocal);
  const rjLocal = allocLocal(fctx, `__pexec_rj_${fctx.locals.length}`, { kind: "externref" });
  emitSettleValue(rejectClFuncIdx, rjLocal);

  // 4. Recover the executor closure struct from the scratch buffer (externref).
  const execLocal = allocLocal(fctx, `__pexec_fn_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: closureInfo.structTypeIdx,
  });
  for (const i of execInstrs) fctx.body.push(i);
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.structTypeIdx });
  fctx.body.push({ op: "local.set", index: execLocal });
  ctx.liveBodies.delete(execInstrs);

  // 5. Invoke the executor synchronously inside try/catch; an executor throw
  //    before settle rejects the promise (the settle guard makes it a no-op if
  //    the executor already settled). Build the invoke into a detached tryBody.
  const reasonLocal = allocLocal(fctx, `__pexec_reason_${fctx.locals.length}`, { kind: "externref" });
  const tryBody: Instr[] = [];
  fctx.savedBodies.push(fctx.body);
  fctx.body = tryBody;
  try {
    // call_ref stack: [self, ...userArgs, funcref]
    fctx.body.push({ op: "local.get", index: execLocal });
    const paramTypes = closureInfo.paramTypes;
    for (let i = 0; i < paramTypes.length; i++) {
      const pType = paramTypes[i]!;
      if (i === 0 || i === 1) {
        // param 0 = resolve, param 1 = reject (both externref in practice).
        fctx.body.push({ op: "local.get", index: i === 0 ? rvLocal : rjLocal });
        if (pType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, pType);
      } else {
        // Executors never declare >2 params in practice; pad defensively.
        pushDefaultValue(fctx, pType, ctx);
      }
    }
    fctx.body.push({ op: "local.get", index: execLocal });
    fctx.body.push({ op: "struct.get", typeIdx: closureInfo.structTypeIdx, fieldIdx: 0 });
    emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
    emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
    if (closureInfo.returnType !== null) fctx.body.push({ op: "drop" });
  } finally {
    fctx.body = fctx.savedBodies.pop()!;
  }

  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches: [
      {
        tagIdx: exnTag,
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: pLocal },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: rejectFuncIdx },
          { op: "drop" },
        ],
      },
    ],
  } as Instr);

  // 6. Result: the pending/settled $Promise as externref.
  fctx.body.push({ op: "local.get", index: pLocal });
  fctx.body.push({ op: "extern.convert_any" });
  return true;
}
