// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3741) Which mutable numeric locals of an IR-lowered function should be
 * STORED as a native `i32` Wasm local instead of `f64`.
 *
 * ## Why this exists
 *
 * The landing-page `loop.ts` benchmark
 *
 *     let s = 0;
 *     for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
 *
 * runs ~16x slower through the IR front-end than through legacy AST-direct
 * codegen. Legacy has had a dedicated promotion since #1120
 * (`collectI32CoercedLocals`) plus the for-counter promotion `detectI32LoopVar`,
 * which together collapse that loop to `i32.add` / `i32.lt_s`. The IR front-end
 * had no equivalent, so every iteration paid an f64 add plus a ~25-instruction
 * JS-ToInt32 bit-manipulation sequence.
 *
 * ## Why *storage*, and not just cheaper ToInt32
 *
 * Measured on the exact benchmark (hand-written `.wat`, node/V8, 1M iterations):
 *
 *   | shape                                                    | median  |
 *   |----------------------------------------------------------|---------|
 *   | both locals `i32` (legacy)                                |  0.41ms |
 *   | both `i32`, f64 view only at the loop condition           |  0.70ms |
 *   | accumulator `i32`, counter `f64`                          |  1.88ms |
 *   | both `f64`, cheap `trunc`/`i32.add`/`convert` per iter    |  7.25ms |
 *   | both `f64`, `f64.add` + `i64.trunc`/`wrap` per iter       |  6.10ms |
 *
 * i.e. **a loop-carried `f64 -> i32 -> f64` round trip costs as much as the
 * whole ToInt32 sequence it replaces**. Making ToInt32 cheaper while leaving the
 * local in an f64 slot buys nothing. The storage kind is the lever.
 *
 * ## Why this is contained (and the previous attempt was not)
 *
 * An earlier #3741 attempt retyped the local's *`IrType`* to i32, which changed
 * what EVERY consumer in `from-ast.ts` observed (array stores, Map slots, early
 * returns, closure captures, …) and produced 13 unrelated failures. This plan
 * instead keeps `ScopeBinding.type` at **f64** — the binding's logical type is
 * unchanged — and only swaps the underlying Wasm slot's ValType. Reads of a
 * promoted slot emit `slot.read` (i32) + `f64.convert_i32_s`, so the SSA value
 * handed to every consumer is f64-typed exactly as before. Only the ~6 sites in
 * `from-ast.ts` that touch a slot *directly* (`readNumericSlot` /
 * `writeNumericSlot`) know about the promotion, plus opt-in fused fast paths
 * that are pure peepholes (they only ever replace a value with a provably
 * bit-identical one of the SAME IrType).
 *
 * ## The proof obligations
 *
 * A promoted slot must satisfy BOTH:
 *   1. **Q-CANON** — the local's VALUE is always exactly a signed int32, so
 *      storing it as i32 and widening on read with `f64.convert_i32_s` is the
 *      identity. This is exactly `collectI32CoercedLocals` (#1120/#1236/#2789),
 *      reused verbatim from legacy; for-loop counters use `detectI32LoopVar`,
 *      also reused verbatim.
 *   2. **Producible** — every write site must be lowerable to an exact i32 by
 *      `from-ast.ts`'s `lowerCanonI32`. This is a structural check on the write
 *      shapes (see `writeShapesAreLowerable` below); a name that fails it is
 *      simply NOT promoted, so the function still compiles exactly as today (no
 *      new legacy fallback, no fallback-budget growth).
 */
import { forEachChild, ts } from "../../ts-api.js";
import { collectI32CoercedLocals } from "../../codegen/analysis/i32-coerced-locals.js";
import { detectI32LoopVar } from "../../codegen/statements/loop-analysis.js";

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

/**
 * "Is this name currently bound to an i32-promoted slot?" The planner answers
 * from its own candidate set; `from-ast.ts` answers from the live `cx.scope`,
 * so an inner shadowing binding can never be mistaken for the promoted one.
 */
export type IsPromotedI32 = (name: string) => boolean;

/** Peel parens / `as` casts / `!` assertions. */
export function peelExpr(e: ts.Expression): ts.Expression {
  let inner: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) {
      inner = inner.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(inner)) {
      inner = inner.expression;
      continue;
    }
    return inner;
  }
}

/** `expr` is an integer literal that fits in a signed 32-bit int. */
export function i32LiteralValue(e: ts.Expression): number | null {
  const inner = peelExpr(e);
  if (ts.isNumericLiteral(inner)) {
    const n = Number(inner.text.replace(/_/g, ""));
    return Number.isInteger(n) && n >= I32_MIN && n <= I32_MAX ? n : null;
  }
  // `-<literal>`: only NON-ZERO, because `-0` is observable in JS and an i32
  // local collapses it to `+0` (the #2789 / #1930-V1 rule).
  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand)
  ) {
    const n = Number(inner.operand.text.replace(/_/g, ""));
    if (!Number.isInteger(n) || n === 0) return null;
    const v = -n;
    return v >= I32_MIN && v <= I32_MAX ? v : null;
  }
  return null;
}

export function isBitwiseToken(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken
    // `>>>` deliberately excluded from the CANON set: it yields a uint32 whose
    // VALUE can exceed 2^31-1, which an i32 local cannot hold (#1120 follow-up).
  );
}

function isComparisonToken(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.LessThanToken ||
    k === ts.SyntaxKind.LessThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanToken ||
    k === ts.SyntaxKind.GreaterThanEqualsToken
  );
}

/**
 * Structural mirror of `from-ast.ts`'s `lowerCanonI32`: can this expression be
 * emitted DIRECTLY as an exact i32 value?
 *
 * (#1930 doctrine.) This is the **Q-CANON** question ("is the value exactly a
 * signed int32?"). It deliberately rejects `+` / `-` / `*` — those are only
 * i32-exact under an enclosing ToInt32, which is the separate **Q-WRAP**
 * question answered by `isWrapI32Lowerable`.
 */
export function isCanonI32Lowerable(e: ts.Expression, promoted: IsPromotedI32, depth = 0): boolean {
  if (depth > 64) return false;
  const inner = peelExpr(e);
  if (i32LiteralValue(inner) !== null) return true;
  if (ts.isIdentifier(inner)) return promoted(inner.text);
  if (ts.isBinaryExpression(inner)) {
    const k = inner.operatorToken.kind;
    // Bitwise (minus `>>>`) always yields an exact int32 regardless of operands.
    if (isBitwiseToken(k)) return true;
    // Magnitude comparisons yield an i32 0/1 in every from-ast arm (f64, i32,
    // string-relational fold, dynamic-relational). `===`/`!==` are deliberately
    // NOT accepted — legacy's Q-CANON matcher excludes them too, and their
    // from-ast lowering has externref arms that throw rather than yield i32.
    if (isComparisonToken(k)) return true;
  }
  return false;
}

/**
 * **Q-WRAP** matcher: may this expression be EVALUATED in i32 such that the
 * result is bit-identical to `ToInt32(spec value)` — GIVEN that the caller
 * guarantees an enclosing ToInt32 (a bitwise operator, or a store into an
 * i32-promoted slot)?
 *
 * Mirrors legacy `binary-ops.ts`'s `isI32PureExpr` minus its `*` arm: `+` / `-`
 * of two int32-range operands are exact in f64 (|a ± b| < 2^32 < 2^53), so the
 * `i32.add` / `i32.sub` wrap equals `ToInt32(f64 result)`. `*` is NOT included —
 * an i32 x i32 product can need 62 bits, which f64 rounds, so `i32.mul` and
 * `ToInt32(f64.mul(..))` genuinely disagree (legacy guards it with a
 * `|operand| < 2^21` proof; out of scope for #3741).
 */
export function isWrapI32Lowerable(e: ts.Expression, promoted: IsPromotedI32, depth = 0): boolean {
  if (depth > 64) return false;
  const inner = peelExpr(e);
  if (isCanonI32Lowerable(inner, promoted, depth)) return true;
  if (ts.isBinaryExpression(inner)) {
    const k = inner.operatorToken.kind;
    if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) {
      return (
        isWrapI32Lowerable(inner.left, promoted, depth + 1) && isWrapI32Lowerable(inner.right, promoted, depth + 1)
      );
    }
  }
  return false;
}

/** Every declaration site of `name` in `fn` (used for shadow detection). */
function countDeclarations(fn: ts.FunctionLikeDeclaration, name: string): number {
  let n = 0;
  const walk = (node: ts.Node): void => {
    if (node !== fn && isFunctionLikeNode(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) n++;
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) n++;
    forEachChild(node, walk);
  };
  if (fn.body) forEachChild(fn.body, walk);
  return n;
}

function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** `name` is referenced from inside a nested function (i.e. captured). */
function isCapturedByNestedFunction(fn: ts.FunctionLikeDeclaration, name: string): boolean {
  let captured = false;
  const walk = (node: ts.Node, insideNested: boolean): void => {
    if (captured) return;
    if (node !== fn && isFunctionLikeNode(node)) {
      forEachChild(node, (c) => walk(c, true));
      return;
    }
    if (insideNested && ts.isIdentifier(node) && node.text === name) {
      captured = true;
      return;
    }
    forEachChild(node, (c) => walk(c, insideNested));
  };
  if (fn.body) forEachChild(fn.body, (c) => walk(c, false));
  return captured;
}

/**
 * Every write to `name` must be a shape the IR can emit as an exact i32.
 * `candidates` is the set being considered for promotion — membership is
 * assumed while checking (the caller iterates to a fixpoint by shrinking).
 */
function writeShapesAreLowerable(
  fn: ts.FunctionLikeDeclaration,
  name: string,
  candidates: ReadonlySet<string>,
  provenCounters: ReadonlySet<string>,
): boolean {
  let ok = true;
  const walk = (node: ts.Node): void => {
    if (!ok) return;
    if (node !== fn && isFunctionLikeNode(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      // Declaration: the initializer must be exactly-i32 lowerable. A missing
      // initializer (`let x;`) is not promotable — the IR's `undefined` init
      // path is unrelated to numeric slots.
      if (!node.initializer || !isCanonI32Lowerable(node.initializer, (n) => candidates.has(n))) ok = false;
    } else if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === name) {
      const k = node.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsToken) {
        if (!isCanonI32Lowerable(node.right, (n) => candidates.has(n))) ok = false;
      } else if (
        k === ts.SyntaxKind.AmpersandEqualsToken ||
        k === ts.SyntaxKind.BarEqualsToken ||
        k === ts.SyntaxKind.CaretEqualsToken ||
        k === ts.SyntaxKind.LessThanLessThanEqualsToken ||
        k === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken
      ) {
        // Bitwise compound assignment always yields an exact int32.
      } else if (
        (k === ts.SyntaxKind.PlusEqualsToken || k === ts.SyntaxKind.MinusEqualsToken) &&
        provenCounters.has(name) &&
        i32LiteralValue(node.right) !== null
      ) {
        // `i += <int literal>` on a `detectI32LoopVar`-proven counter — the same
        // bounded-by-the-loop-condition step legacy promotes. NOT accepted for a
        // general accumulator (that is exactly the #1236 saturation trap).
      } else if (COMPOUND_ASSIGN_TOKENS.has(k)) {
        ok = false;
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      // `x++` / `--x` lower to `i32.add`/`i32.sub` of 1 — the same wrap legacy
      // has emitted for promoted locals since #1120. from-ast only lowers these
      // in result-discarding position (`lowerIncrementDecrement` returns void);
      // a value-position `x++` throws there today, so require the same shape
      // here rather than promoting a local whose write we would never reach.
      if (!isDiscardedIncDecPosition(node)) ok = false;
    }
    forEachChild(node, walk);
  };
  if (fn.body) forEachChild(fn.body, walk);
  return ok;
}

const COMPOUND_ASSIGN_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** `x++` whose result value is discarded (statement / for-incrementor). */
function isDiscardedIncDecPosition(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isExpressionStatement(p)) return true;
  if (ts.isForStatement(p) && p.incrementor === node) return true;
  return false;
}

/**
 * Plan which slot-bound locals of `fn` get native i32 storage.
 *
 * `mutatedLets` is from-ast's own "this name is reassigned somewhere" set — only
 * those names get a slot at all, so only those can be promoted.
 */
export function planI32Slots(fn: ts.FunctionLikeDeclaration, mutatedLets: ReadonlySet<string>): ReadonlySet<string> {
  if (!fn.body || !ts.isBlock(fn.body) || mutatedLets.size === 0) return EMPTY;

  // (1) Q-CANON — legacy's hardened value proof, reused verbatim.
  const canon = collectI32CoercedLocals(fn);

  // (1b) for-loop counters, via legacy's `detectI32LoopVar` (also verbatim).
  // `collectI32CoercedLocals` deliberately does NOT return these (it only
  // records them as dependencies) because legacy promotes them through the
  // separate loop path.
  const counters = new Set<string>();
  const collectCounters = (node: ts.Node): void => {
    if (node !== fn && isFunctionLikeNode(node)) return;
    if (ts.isForStatement(node)) {
      const info = detectI32LoopVar(node);
      if (info) counters.add(info.name);
    }
    forEachChild(node, collectCounters);
  };
  forEachChild(fn.body, collectCounters);

  const candidates = new Set<string>();
  for (const n of canon) if (mutatedLets.has(n)) candidates.add(n);
  for (const n of counters) if (mutatedLets.has(n)) candidates.add(n);
  if (candidates.size === 0) return EMPTY;

  // (2) Structural guards. `collectI32CoercedLocals` already applies the
  // shadowing / capture guards to ITS candidates, but the counter set comes
  // from a shape matcher that does not, so apply them uniformly here.
  for (const name of [...candidates]) {
    if (countDeclarations(fn, name) !== 1 || isCapturedByNestedFunction(fn, name)) candidates.delete(name);
  }

  // (3) Producibility fixpoint: shrink until every remaining name's writes are
  // all lowerable to an exact i32 *using only the surviving names*.
  for (;;) {
    let changed = false;
    for (const name of [...candidates]) {
      if (!writeShapesAreLowerable(fn, name, candidates, counters)) {
        candidates.delete(name);
        changed = true;
      }
    }
    if (!changed) break;
    if (candidates.size === 0) return EMPTY;
  }

  return candidates.size === 0 ? EMPTY : candidates;
}

const EMPTY: ReadonlySet<string> = new Set<string>();
