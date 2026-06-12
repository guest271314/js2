// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2056) Wasm-native IEEE-754 remainder (`fmod`) helper for the JS `%`
 * operator on f64 operands.
 *
 * ## Why a dedicated function instead of inline `a - trunc(a/b)*b`
 * The legacy formula `a - trunc(a/b)*b` (+ `f64.copysign`) is NOT
 * [Number::remainder (§6.1.6.1.6)](https://tc39.es/ecma262/#sec-numeric-types-number-remainder),
 * which is the *exact* mathematical remainder (IEEE fmod). The formula has
 * three rounding steps and:
 *   - drifts by ULPs whenever `a/b` rounds,
 *   - collapses to `0` when `trunc(a/b)*b` rounds back to `a`
 *     (e.g. `1e16 % 0.0001`, `123456789.123 % 0.001`),
 *   - produces `±Infinity` when `a/b` overflows f64 (ratio ≳ 1e308,
 *     e.g. `1e308 % 1e-308`) — a categorically wrong value from core arithmetic.
 *
 * ## Algorithm — exact, no host import (dual-mode standalone)
 * Classic binary long-division remainder operating purely in f64. All
 * intermediate values stay ≤ |a|, so nothing overflows, and every step is an
 * exact f64 operation (multiply/halve by 2 and subtraction of aligned values
 * are exact), so there is zero rounding drift:
 *
 *   fmod(a, b):
 *     if b == 0 or a is ±Inf or a/b is NaN          -> NaN
 *     if b is ±Inf (a finite)                        -> a
 *     x = |a|; y = |b|
 *     if x < y                                       -> copysign(x, a)
 *     t = y; while (t * 2 <= x) t *= 2     // t = y·2^k, largest ≤ x
 *     while (t >= y) { if (x >= t) x -= t; t *= 0.5 }
 *     return copysign(x, a)
 *
 * Iteration count is bounded by the binary-exponent difference of the operands
 * (≤ ~2098), i.e. O(1) for ordinary operands and bounded in the worst case.
 * Verified bit-for-bit against Node for the #2056 repro set, the #216 edge
 * cases (`x % Inf`, `-0 % x`, `x % -x`, `Inf % x`, `x % 0`, `NaN % x`), and
 * 500k randomized cases including subnormal divisors.
 *
 * The funcIdx is registered in `funcMap` (not handed out as a raw number) so
 * the late-import index-shift contract (#329/#1899) patches both the map entry
 * and every emitted `call` by the same delta — same discipline as the accessor
 * drivers (`accessor-driver.ts`).
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

/** Reserved name for the f64 remainder helper. */
export const FMOD_FN = "__fmod";

/**
 * Ensure the `__fmod` helper function exists in the module and return its
 * funcIdx. Idempotent — a second call returns the already-registered index.
 *
 * Signature: `(f64 a, f64 b) -> f64`.
 */
export function ensureFmod(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(FMOD_FN);
  if (existing !== undefined) return existing;

  const sigIdx = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "f64" }], "$fmod_type");
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;

  // Locals (after the two f64 params at indices 0=a, 1=b):
  //   2 = x (|a|, running remainder), 3 = y (|b|), 4 = t (aligned divisor)
  const A = 0;
  const B = 1;
  const X = 2;
  const Y = 3;
  const T = 4;

  const INF = Infinity;

  // result = a (sign carrier) — early `a` return for |a| < |b| and the NaN /
  // Inf-divisor cases all flow through copysign(result, a) at the end except
  // where the spec wants raw NaN. We special-case NaN/Inf up front.
  const body: Instr[] = [
    // ── Non-finite / zero-divisor fast cases ───────────────────────────────
    // if (b == 0) return NaN
    { op: "local.get", index: B },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (|a| == Inf) return NaN   (Inf % x, and NaN propagates below too)
    { op: "local.get", index: A },
    { op: "f64.abs" },
    { op: "f64.const", value: INF },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (a != a) return NaN  (NaN dividend)
    { op: "local.get", index: A },
    { op: "local.get", index: A },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (b != b) return NaN  (NaN divisor)
    { op: "local.get", index: B },
    { op: "local.get", index: B },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (|b| == Inf) return a  (a is finite here → remainder is a itself)
    { op: "local.get", index: B },
    { op: "f64.abs" },
    { op: "f64.const", value: INF },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: A }, { op: "return" }],
    },

    // ── x = |a|; y = |b| ───────────────────────────────────────────────────
    { op: "local.get", index: A },
    { op: "f64.abs" },
    { op: "local.set", index: X },
    { op: "local.get", index: B },
    { op: "f64.abs" },
    { op: "local.set", index: Y },

    // if (x < y) return copysign(x, a)   (covers x == 0 too → ±0)
    { op: "local.get", index: X },
    { op: "local.get", index: Y },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: X }, { op: "local.get", index: A }, { op: "f64.copysign" }, { op: "return" }],
    },

    // ── t = y; while (t * 2 <= x) t *= 2 ───────────────────────────────────
    { op: "local.get", index: Y },
    { op: "local.set", index: T },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if !(t * 2 <= x) break
            { op: "local.get", index: T },
            { op: "f64.const", value: 2 },
            { op: "f64.mul" },
            { op: "local.get", index: X },
            { op: "f64.le" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // t = t * 2
            { op: "local.get", index: T },
            { op: "f64.const", value: 2 },
            { op: "f64.mul" },
            { op: "local.set", index: T },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // ── while (t >= y) { if (x >= t) x -= t; t *= 0.5 } ─────────────────────
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if !(t >= y) break
            { op: "local.get", index: T },
            { op: "local.get", index: Y },
            { op: "f64.ge" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // if (x >= t) x = x - t
            { op: "local.get", index: X },
            { op: "local.get", index: T },
            { op: "f64.ge" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: X },
                { op: "local.get", index: T },
                { op: "f64.sub" },
                { op: "local.set", index: X },
              ],
            },
            // t = t * 0.5
            { op: "local.get", index: T },
            { op: "f64.const", value: 0.5 },
            { op: "f64.mul" },
            { op: "local.set", index: T },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return copysign(x, a)  — sign of the dividend, incl. -0 case
    { op: "local.get", index: X },
    { op: "local.get", index: A },
    { op: "f64.copysign" },
  ];

  const fn: WasmFunction = {
    name: FMOD_FN,
    typeIdx: sigIdx,
    locals: [
      { name: "$x", type: { kind: "f64" } }, // X
      { name: "$y", type: { kind: "f64" } }, // Y
      { name: "$t", type: { kind: "f64" } }, // T
    ],
    body,
    exported: false,
  };
  ctx.mod.functions.push(fn);
  ctx.funcMap.set(FMOD_FN, funcIdx);
  return funcIdx;
}
