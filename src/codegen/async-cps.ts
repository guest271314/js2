// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Async/await CPS (continuation-passing-style) lowering — module skeleton (#1042).
//
// This is the shared analysis + emission surface that both the AST path (#1042)
// and the IR path (#1373b) call into to turn an `async function` body into a
// generator-style state machine: split at each `await`, compile each segment as
// a continuation, chain them via Promise.then.
//
// PR1 scope (this commit): the SURFACE only.
//   - `analyzeAsyncBody` is real and pure — it walks the body, finds await
//     points, and computes the live-local set carried across each await. No
//     codegen side effects. This is what the tests exercise.
//   - `emitAsyncStateMachine` / `compileNestedAwait` are present but inert:
//     the activation hook in function-body.ts is NOT wired in this PR, and the
//     `asyncCpsActive` gate (see ASYNC_CPS_ENABLED) is hardcoded false, so the
//     emit path is never reached. Emitted Wasm is byte-identical to before —
//     same inert-first pattern as #1586 (alloc sites) and #1587 (ownership).
//   - `emitAsyncStateMachineFromIr` is a stub returning false (#1373b fills it).
//
// The full lowering (segment emission, capture structs, Promise.then chaining)
// lands in follow-up PRs. See plan/issues/backlog/1042-async-await-state-machine-lowering.md.

import { ts, forEachChild } from "../ts-api.js";
import { reportError } from "./context/errors.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { collectReferencedIdentifiers, collectBindingPatternNames } from "./closures.js";

/**
 * Master gate for the AST-side async CPS lowering.
 *
 * Hardcoded `false` for PR1 (#1042) — exactly like #1373b Slice 1's
 * `supportsAsyncIr` flag. While false, `function-body.ts` never activates the
 * state machine and async functions take the unchanged legacy direct-codegen
 * path, so the emitted module is byte-identical. Subsequent slices flip this on
 * incrementally once the lowering is parity-tested against the legacy path.
 */
export const ASYNC_CPS_ENABLED = false;

/**
 * Result of analysing an async function body for the CPS transform.
 * Populated by {@link analyzeAsyncBody}, consumed by {@link emitAsyncStateMachine}.
 */
export interface AsyncCpsPlan {
  /** Pre-order list of await points found in the body (by `ts.Node` identity). */
  readonly awaitPoints: readonly ts.AwaitExpression[];
  /**
   * For each await point: the set of live local names that must be captured
   * into the continuation that resumes after the await. "Live" = referenced in
   * any statement/expression that executes after the await point.
   */
  readonly liveAfterAwait: ReadonlyMap<ts.AwaitExpression, ReadonlySet<string>>;
  /** Does the body contain a `try`/`catch` that spans an await? (Phase 3B — gated.) */
  readonly hasTryAcrossAwait: boolean;
  /** Does the body contain a `throw` that must reject the outer Promise? */
  readonly hasUncaughtThrow: boolean;
}

/**
 * Walk the body of an async function / arrow / method and produce a plan.
 *
 * Pure analysis — no codegen side effects, no `ctx`/`fctx` mutation. Safe to
 * call speculatively (the function-body hook calls it to decide whether a
 * function needs CPS at all: zero await points ⇒ legacy path).
 */
export function analyzeAsyncBody(_ctx: CodegenContext, fn: ts.FunctionLikeDeclaration): AsyncCpsPlan {
  const awaitPoints: ts.AwaitExpression[] = [];
  const body = fn.body;

  // Collect await points in pre-order, WITHOUT descending into nested function
  // scopes — a nested `async` function/arrow has its own state machine and its
  // awaits do not suspend the enclosing function.
  if (body !== undefined) {
    collectAwaitPoints(body, awaitPoints);
  }

  // Live-after-await: for each await, the names referenced in the textual
  // remainder of the body. PR1 uses a conservative whole-remainder
  // approximation (everything that lexically follows the await). Precise
  // segment-based liveness is refined in the lowering PR; over-approximation is
  // safe (we capture a superset, never miss a live local).
  //
  // NOTE: we collect ALL declared names — params + var + let + const — not just
  // function-scoped vars. `collectFunctionOwnLocals` deliberately skips let/const
  // (block-scoped, irrelevant to closure var-hoisting), but for CPS a let/const
  // declared before an await and read after it MUST be carried into the
  // continuation, so we need the full set.
  const ownLocals = new Set<string>();
  collectAllDeclaredNames(fn, ownLocals);

  const liveAfterAwait = new Map<ts.AwaitExpression, ReadonlySet<string>>();
  for (const awaitExpr of awaitPoints) {
    const referencedAfter = new Set<string>();
    collectReferencedAfter(body!, awaitExpr, referencedAfter);
    // Keep only names that are params/locals of THIS function — globals and
    // imports don't need capturing.
    const live = new Set<string>();
    for (const name of referencedAfter) {
      if (ownLocals.has(name)) live.add(name);
    }
    liveAfterAwait.set(awaitExpr, live);
  }

  return {
    awaitPoints,
    liveAfterAwait,
    hasTryAcrossAwait: awaitPoints.length > 0 && bodyHasTryAcrossAwait(body),
    hasUncaughtThrow: body !== undefined && bodyHasUncaughtThrow(body),
  };
}

/**
 * Emit a CPS-lowered async function body into `fctx`, replacing the normal
 * statement loop. Drives the entire body; the caller skips its own loop.
 *
 * PR1: INERT. The activation hook (function-body.ts) is not wired and
 * {@link ASYNC_CPS_ENABLED} is false, so this is never reached in normal
 * compilation. If it is somehow invoked, fail loudly rather than emit a
 * half-formed body — the full lowering lands in a follow-up PR.
 */
export function emitAsyncStateMachine(
  ctx: CodegenContext,
  _fctx: FunctionContext,
  fn: ts.FunctionLikeDeclaration,
  _plan: AsyncCpsPlan,
): void {
  reportError(
    ctx,
    fn,
    "internal: async CPS state-machine lowering not yet implemented (#1042 PR1 is skeleton-only; lowering lands in a follow-up PR)",
  );
}

/**
 * Compile a nested `await` encountered while the surrounding
 * {@link emitAsyncStateMachine} is driving the body (e.g. `await (x + await y)`).
 *
 * PR1: stub. Nested awaits within a single segment are a follow-up; the joint
 * spec §6.2 lists `return await` as the only tail case required in Slice 2A.
 */
export function compileNestedAwait(ctx: CodegenContext, _fctx: FunctionContext, expr: ts.AwaitExpression): never {
  reportError(
    ctx,
    expr,
    "internal: nested await not yet supported (#1042 PR1 skeleton; follow-up PR adds segment-internal await continuations)",
  );
  // reportError does not return control flow that TS can prove; satisfy `never`.
  throw new Error("unreachable");
}

/**
 * IR entry point (Phase 2B / #1373b). Same machinery, IR input.
 *
 * PR1: stub returning `false` (means "did not handle; caller uses legacy
 * path"). #1373b fills this in.
 */
export function emitAsyncStateMachineFromIr(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers (private to async-cps.ts)
// ---------------------------------------------------------------------------

/**
 * Collect every binding name declared by this function — params (incl.
 * destructuring) and ALL body variable declarations (var/let/const), plus
 * catch-clause params — without crossing nested function scopes. Unlike
 * `collectFunctionOwnLocals` this does NOT skip let/const: CPS liveness must
 * carry any local read after an await, regardless of block scoping.
 */
function collectAllDeclaredNames(fn: ts.FunctionLikeDeclaration, out: Set<string>): void {
  // Params.
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) out.add(p.name.text);
    else collectBindingPatternNames(p.name, out);
  }
  const body = fn.body;
  if (body === undefined) return;
  const walk = (node: ts.Node): void => {
    if (isNestedFunctionScope(node)) return; // their locals are theirs, not ours
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) out.add(node.name.text);
      else collectBindingPatternNames(node.name, out);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const vd = node.variableDeclaration;
      if (ts.isIdentifier(vd.name)) out.add(vd.name.text);
      else collectBindingPatternNames(vd.name, out);
    }
    forEachChild(node, walk);
  };
  walk(body);
}

/** True for nodes that open a new function scope (awaits inside don't suspend us). */
function isNestedFunctionScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Collect `await` expressions in pre-order, not descending into nested fn scopes. */
function collectAwaitPoints(node: ts.Node, out: ts.AwaitExpression[]): void {
  if (isNestedFunctionScope(node)) return;
  if (ts.isAwaitExpression(node)) {
    out.push(node);
    // Continue into the operand — `await (await x)` has two await points.
  }
  forEachChild(node, (child) => collectAwaitPoints(child, out));
}

/**
 * Collect identifiers referenced strictly AFTER `target` in document order
 * within `root`, not descending into nested function scopes. Conservative:
 * once we pass the target node, everything subsequently visited counts.
 */
function collectReferencedAfter(root: ts.Node, target: ts.AwaitExpression, out: Set<string>): void {
  let passedTarget = false;
  const walk = (node: ts.Node): void => {
    if (node === target) {
      passedTarget = true;
      return; // the await's own operand executes BEFORE resumption — skip it
    }
    if (isNestedFunctionScope(node)) {
      // A nested scope after the target may still reference our locals (closure
      // capture), so when we're already past the target, collect from it too.
      if (passedTarget) collectReferencedIdentifiers(node, out);
      return;
    }
    if (passedTarget && ts.isIdentifier(node)) {
      out.add(node.text);
    }
    forEachChild(node, walk);
  };
  walk(root);
}

/** Does any await sit lexically inside a `try` block? (Conservative.) */
function bodyHasTryAcrossAwait(body: ts.Node | undefined): boolean {
  if (body === undefined) return false;
  let found = false;
  const walk = (node: ts.Node, insideTry: boolean): void => {
    if (found || isNestedFunctionScope(node)) return;
    if (insideTry && ts.isAwaitExpression(node)) {
      found = true;
      return;
    }
    if (ts.isTryStatement(node)) {
      // Only the try-block (and catch) span an await for rejection routing.
      walk(node.tryBlock, true);
      if (node.catchClause) walk(node.catchClause, true);
      if (node.finallyBlock) walk(node.finallyBlock, insideTry);
      return;
    }
    forEachChild(node, (child) => walk(child, insideTry));
  };
  walk(body, false);
  return found;
}

/** Does the body contain a `throw` outside any try/catch? (Conservative.) */
function bodyHasUncaughtThrow(body: ts.Node): boolean {
  let found = false;
  const walk = (node: ts.Node, insideTry: boolean): void => {
    if (found || isNestedFunctionScope(node)) return;
    if (!insideTry && ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    if (ts.isTryStatement(node)) {
      walk(node.tryBlock, true);
      // A throw in catch/finally is still "uncaught" by this try.
      if (node.catchClause) walk(node.catchClause, insideTry);
      if (node.finallyBlock) walk(node.finallyBlock, insideTry);
      return;
    }
    forEachChild(node, (child) => walk(child, insideTry));
  };
  walk(body, false);
  return found;
}
