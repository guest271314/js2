// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted Math builtins (#3141 — the porffor model, pilot).
 *
 * Each builtin here is ORDINARY TypeScript source written in the
 * IR-claimable subset (annotated f64 params/locals, if/while/return,
 * ternaries, `Math.<abs|sqrt|floor|ceil|trunc>` — the #1371 whitelist —
 * and direct calls to sibling helpers by their funcMap name). The
 * compiler compiles these through its OWN pipeline at compile time
 * (`src/codegen/stdlib-selfhost.ts`: from-ast → IR passes → BackendEmitter)
 * and registers the result exactly where the hand-emitted `Instr[]`
 * versions used to be pushed (`emitInlineMathFunctions`).
 *
 * DIALECT RULES (keep sources inside the claimable subset):
 *   - every param/local/return annotated `: number` (lowered f64);
 *   - no `NaN` / `Infinity` identifiers (not in the IR subset):
 *       * "input is NaN"    → `if (x !== x) return x;` (returns the NaN);
 *       * "produce NaN"     → `0 / 0`;
 *       * "input is ±Inf"   → `Math.abs(x) > 1.7976931348623157e308`
 *         (only ±Infinity exceeds MAX_VALUE; NaN was returned earlier);
 *   - sibling-helper calls (`Math_exp(x)`) resolve by funcMap name at
 *     lowering time — list them in `callees` so the driver seeds
 *     `calleeTypes`; the callee must be registered before this builtin
 *     is emitted (Phase-1 core funcs precede Phase-2 derived ones in
 *     `emitInlineMathFunctions`).
 *
 * NUMERIC EQUIVALENCE: each source mirrors the deleted hand-written
 * `Instr[]` body op-for-op (same operand order, same special-case
 * ladder), so results are bit-identical — IEEE f64 add/sub/mul/div/sqrt
 * are deterministic and identical between the hand-scheduled and
 * IR-scheduled instruction streams. Redundant ±Infinity special cases
 * were dropped ONLY where the shared core (`Math_exp` / `Math_log`)
 * already produces the identical value for the infinite input (noted
 * per function).
 */

export interface StdlibMathBuiltin {
  /** funcMap registration name — also the function's name in `source`. */
  readonly name: string;
  /** Sibling math helpers this builtin calls (all `(f64) -> f64`). */
  readonly callees: readonly string[];
  /** Ordinary TS source, IR-claimable subset (see header). */
  readonly source: string;
}

/**
 * Math.cbrt — cube root via Newton's method (8 iterations, seeded with
 * copysign(sqrt(sqrt(|x|)), x)). Mirrors the hand version exactly: for
 * x < 0 every Newton step is the exact IEEE negation of the positive
 * run, so seeding with -sqrt(sqrt(|x|)) and iterating signed matches
 * the deleted copysign-seeded body bit-for-bit.
 */
const CBRT_SOURCE = `
export function Math_cbrt(x: number): number {
  if (x === 0) return x;
  if (x !== x) return x;
  let ax: number = Math.abs(x);
  if (ax > 1.7976931348623157e308) return x;
  let guess: number = Math.sqrt(Math.sqrt(ax));
  if (x < 0) guess = -guess;
  let i: number = 8;
  while (i > 0) {
    guess = (guess * 2 + x / (guess * guess)) / 3;
    i = i - 1;
  }
  return guess;
}
`;

/**
 * Math.sinh = (exp(x) - 1/exp(x)) / 2. §21.3.2.31: sinh(±0) = ±0.
 * ±Infinity specials dropped: Math_exp(+Inf)=Inf → (Inf - 0)/2 = Inf;
 * Math_exp(-Inf)=0 → (0 - Inf)/2 = -Inf — identical to the hand ladder.
 */
const SINH_SOURCE = `
export function Math_sinh(x: number): number {
  if (x !== x) return x;
  if (x === 0) return x;
  let ep: number = Math_exp(x);
  return (ep - 1 / ep) / 2;
}
`;

/**
 * Math.cosh = (exp(x) + 1/exp(x)) / 2.
 * ±Infinity special dropped: exp(±Inf) ∈ {Inf, 0} → (Inf+0)/2 = Inf both ways.
 */
const COSH_SOURCE = `
export function Math_cosh(x: number): number {
  if (x !== x) return x;
  let ep: number = Math_exp(x);
  return (ep + 1 / ep) / 2;
}
`;

/**
 * Math.tanh = (exp(2x) - 1) / (exp(2x) + 1), saturated at |x| > 20.
 * §21.3.2.34: tanh(±0) = ±0.
 */
const TANH_SOURCE = `
export function Math_tanh(x: number): number {
  if (x !== x) return x;
  if (x > 20) return 1;
  if (x < -20) return -1;
  if (x === 0) return x;
  let e2x: number = Math_exp(x * 2);
  return (e2x - 1) / (e2x + 1);
}
`;

/**
 * Math.asinh = sign(x) * log(|x| + sqrt(x*x + 1)).
 * asinh(±0) = ±0 handled up front (the ternary sign-restore cannot
 * produce -0). ±Infinity specials dropped: log(Inf + Inf) = Inf via the
 * Math_log special ladder, sign restored by the ternary. The log
 * argument is > 1 for every remaining x, so r > 0 and `x < 0 ? -r : r`
 * equals the hand version's copysign(r, x).
 */
const ASINH_SOURCE = `
export function Math_asinh(x: number): number {
  if (x !== x) return x;
  if (x === 0) return x;
  let r: number = Math_log(Math.abs(x) + Math.sqrt(x * x + 1));
  return x < 0 ? -r : r;
}
`;

/**
 * Math.acosh = log(x + sqrt(x*x - 1)); domain x >= 1.
 */
const ACOSH_SOURCE = `
export function Math_acosh(x: number): number {
  if (x !== x) return x;
  if (x < 1) return 0 / 0;
  if (x === 1) return 0;
  return Math_log(x + Math.sqrt(x * x - 1));
}
`;

/**
 * Math.atanh = 0.5 * log((1+x)/(1-x)); domain |x| <= 1. atanh(±0) = ±0.
 * x === ±1 specials dropped: (2)/(0) = +Inf → log = +Inf, and
 * (0)/(2) = 0 → log(0) = -Inf via the Math_log special ladder —
 * identical to the hand version's explicit returns.
 */
const ATANH_SOURCE = `
export function Math_atanh(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) > 1) return 0 / 0;
  if (x === 0) return x;
  return Math_log((1 + x) / (1 - x)) * 0.5;
}
`;

/**
 * Math.expm1 = exp(x) - 1, Taylor (order 4) below |x| < 1e-5 for
 * precision. expm1(±0) = ±0. ±Infinity specials dropped:
 * exp(Inf)-1 = Inf; exp(-Inf)-1 = -1 — identical to the hand ladder.
 */
const EXPM1_SOURCE = `
export function Math_expm1(x: number): number {
  if (x !== x) return x;
  if (x === 0) return x;
  if (Math.abs(x) < 1e-5) {
    return x + x * x * 0.5 + x * x * x * (1 / 6) + x * x * x * x * (1 / 24);
  }
  return Math_exp(x) - 1;
}
`;

/**
 * Math.log1p = log(1 + x), Taylor (order 3) below |x| < 1e-4.
 * log1p(±0) = ±0 falls out of the Taylor arm (x - (+0) keeps the sign
 * of x, matching the hand instruction sequence). x === -1 → -Inf and
 * x < -1 → NaN both fall out of Math_log's own ladder (log(0) = -Inf,
 * log(negative) = NaN).
 */
const LOG1P_SOURCE = `
export function Math_log1p(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) < 1e-4) {
    return x - x * x * 0.5 + x * x * x * (1 / 3);
  }
  return Math_log(1 + x);
}
`;

/**
 * The self-hosted subset of the Math family, keyed by `Math.<method>`
 * name. Phase-1 cores (sin/cos/exp/log/atan, atan2/pow, log2/log10,
 * random) stay hand-emitted for now — they are the precision-sensitive
 * range-reduction kernels; converting them is the scale-up decision
 * this pilot informs (#3141 verdict / battle-plan slice 9).
 */
export const SELF_HOSTED_MATH: ReadonlyMap<string, StdlibMathBuiltin> = new Map([
  ["cbrt", { name: "Math_cbrt", callees: [], source: CBRT_SOURCE }],
  ["sinh", { name: "Math_sinh", callees: ["Math_exp"], source: SINH_SOURCE }],
  ["cosh", { name: "Math_cosh", callees: ["Math_exp"], source: COSH_SOURCE }],
  ["tanh", { name: "Math_tanh", callees: ["Math_exp"], source: TANH_SOURCE }],
  ["asinh", { name: "Math_asinh", callees: ["Math_log"], source: ASINH_SOURCE }],
  ["acosh", { name: "Math_acosh", callees: ["Math_log"], source: ACOSH_SOURCE }],
  ["atanh", { name: "Math_atanh", callees: ["Math_log"], source: ATANH_SOURCE }],
  ["expm1", { name: "Math_expm1", callees: ["Math_exp"], source: EXPM1_SOURCE }],
  ["log1p", { name: "Math_log1p", callees: ["Math_log"], source: LOG1P_SOURCE }],
]);
