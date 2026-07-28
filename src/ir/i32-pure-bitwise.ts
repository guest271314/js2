// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3745) IR-build-time fast path for bitwise-operator operands that are
 * PROVABLY already clean, in-range int32 values.
 *
 * Background: IR lowers `x & y` / `x | y` / `x ^ y` / shifts as the
 * composite `js.bit*` op — ECMA-262-faithful ToInt32 on BOTH operands (a
 * ~15-instruction IEEE-754 bit-decomposition dance, #3739), a native i32 op,
 * then convert back to f64. `ir/lower.ts` already skips that dance when an
 * operand's IR value happens to carry `IrType.kind === "i32"` — but nothing
 * in `ir/from-ast.ts` ever produces an i32-typed value for a plain
 * `number`-typed local or loop counter (every un-annotated local defaults to
 * f64 storage), so that fast path is currently unreachable for ordinary
 * user code such as `(i * 13) & 31` in a `for` loop.
 *
 * A prior attempt (documented in #3741) tried to close this by RETYPING
 * such locals' declared `IrType` from f64 to i32 globally. That changes
 * what EVERY consumer in the function sees (return, array/Map storage,
 * closures, …) and was reverted after a broad test sweep found 13 new
 * failures — unaudited consumption sites that assumed "un-annotated locals
 * are always f64" outside the one function that read the type correctly.
 *
 * This module takes a narrower, additive route instead: it NEVER changes
 * what any local's declared IrType is. It only recognizes, at the exact
 * point a bitwise operator's operand is about to be lowered, whether that
 * operand expression is built ENTIRELY from values already proven to be
 * clean int32s — reusing the legacy codegen's own battle-tested proofs
 * (`collectI32CoercedLocals`, `detectI32LoopVar`) rather than re-deriving
 * them. When the whole operand subtree qualifies, `from-ast.ts` lowers it
 * exactly as it does today (ordinary f64 arithmetic — zero new
 * instructions, zero new IrBinop variants) and wraps the RESULT with the
 * cheap `i32.trunc_sat_f64_s` unary instead of the expensive ToInt32 dance.
 * `i32.trunc_sat_f64_s` is bit-for-bit equivalent to ToInt32 exactly when
 * the input is already an integer in [-2^31, 2^31) — which is precisely
 * what the reused proofs establish — so this is a pure "compute the same
 * f64 value with a cheaper final conversion" optimization, invisible to
 * every other consumer of the local (which still reads a plain f64, same
 * as before this module existed).
 *
 * Deliberately excludes call expressions (e.g. `String.prototype.
 * charCodeAt`) as leaves: legacy's own `isI32PureExpr` (`binary-ops.ts`)
 * carries a documented #1105 exception for exactly this reason — a NaN
 * result (out-of-bounds charCodeAt) truncates to 0 under BOTH ToInt32 and
 * `trunc_sat_f64_s`, but fusing it into a NATIVE i32 add of an enclosing sum
 * (`(a + x.charCodeAt(i)) | 0`) would incorrectly preserve `a`'s bits
 * instead of collapsing the WHOLE sum to 0 the way `ToInt32(a + NaN) =
 * ToInt32(NaN) = 0` does. Legacy only lifts that exception behind a
 * separate, narrow "provably in-bounds hoisted read" proof (#2682); this
 * module does not attempt to port that proof, so an expression containing
 * ANY call falls through to the existing (correct, unchanged) general path.
 */
import { forEachChild, ts } from "../ts-api.js";
import { collectI32CoercedLocals } from "../codegen/function-body.js";
import { detectI32LoopVar } from "../codegen/statements/loop-analysis.js";

/** Names (function-wide) proven to always hold a clean int32 value when read. */
export type I32PureNames = ReadonlySet<string>;

const FUNCTION_SCOPE_KINDS = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isAccessor(node) ||
  ts.isConstructorDeclaration(node);

/**
 * Union of `collectI32CoercedLocals` (mutated/const locals whose every
 * write is bitwise-coerced or an in-range literal) and every canonical
 * `for (let i = INT; i < …; i++)` counter name `detectI32LoopVar` accepts —
 * the same two proofs legacy's own #1120/#1236 i32-local promotion uses.
 * Computed once per top-level function declaration; nested functions get
 * their own independent set (never merged with an outer scope's).
 */
export function computeI32PureNames(fn: ts.FunctionLikeDeclaration): I32PureNames {
  const names = new Set<string>(collectI32CoercedLocals(fn));
  if (fn.body && ts.isBlock(fn.body)) {
    const visit = (node: ts.Node): void => {
      if (node !== fn && FUNCTION_SCOPE_KINDS(node)) return; // nested scope — independent
      if (ts.isForStatement(node)) {
        const info = detectI32LoopVar(node);
        if (info) names.add(info.name);
      }
      forEachChild(node, visit);
    };
    forEachChild(fn.body, visit);
  }
  return names;
}

function peel(e: ts.Expression): ts.Expression {
  let inner: ts.Expression = e;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** Mirrors legacy binary-ops.ts's `isI32MulSafe`: at least one operand must be a small (|n| < 2^21) integer literal, so the true product stays exactly representable in f64 and i32.mul-equivalent. */
function isSmallIntLiteral(e: ts.Expression): boolean {
  const inner = peel(e);
  if (!ts.isNumericLiteral(inner)) return false;
  const n = Number(inner.text.replace(/_/g, ""));
  return Number.isInteger(n) && Math.abs(n) < 1 << 21;
}

function isBitwiseOpKind(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
  );
}

/**
 * True iff `e`'s value, when read, is provably already a clean integer in
 * [-2^31, 2^31) — safe to obtain via `i32.trunc_sat_f64_s` instead of the
 * full ToInt32 dance. Leaves: an identifier in `names`, or an in-range
 * integer literal. Recursive arms: `+`/`-` (exact in f64 for i32-range
 * operands, so the sum/difference is itself i32-range or trivially
 * ToInt32-wrapped consistently — same reasoning as legacy's `isI32PureExpr`);
 * guarded `*` (`isSmallIntLiteral` on at least one side, matching the 2^53
 * f64-exactness precondition); and any nested bitwise/shift op (its own
 * result is ALWAYS int32-range by construction, regardless of its operands).
 */
export function isI32PureExprIR(e: ts.Expression, names: I32PureNames): boolean {
  const inner = peel(e);
  if (ts.isIdentifier(inner)) return names.has(inner.text);
  if (ts.isNumericLiteral(inner)) {
    const n = Number(inner.text.replace(/_/g, ""));
    return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
  }
  if (!ts.isBinaryExpression(inner)) return false;
  const k = inner.operatorToken.kind;
  if (isBitwiseOpKind(k)) {
    return isI32PureExprIR(inner.left, names) && isI32PureExprIR(inner.right, names);
  }
  if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) {
    return isI32PureExprIR(inner.left, names) && isI32PureExprIR(inner.right, names);
  }
  if (k === ts.SyntaxKind.AsteriskToken) {
    return (
      isI32PureExprIR(inner.left, names) &&
      isI32PureExprIR(inner.right, names) &&
      (isSmallIntLiteral(inner.left) || isSmallIntLiteral(inner.right))
    );
  }
  return false;
}

/** The six bitwise/shift operator token kinds this module's fast path applies to. */
export function isIrBitwiseOperatorToken(k: ts.SyntaxKind): boolean {
  return isBitwiseOpKind(k);
}
