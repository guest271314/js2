---
id: 3233
title: "self-host stdlib: convert Math.atan2 to TS source (last non-dialect-gap Math core)"
status: done
assignee: ttraenkler/opus-selfhost2
sprint: Backlog
priority: medium
horizon: s
feasibility: medium
task_type: enhancement
area: codegen, ir, stdlib
language_feature: math-builtins
goal: ir-full-coverage
created: 2026-07-13
completed: 2026-07-13
depends_on: [3161, 3204]
related: [3141, 3226]
---

# #3233 — self-host Math.atan2 (last non-dialect-gap Math core)

## Problem

The self-hosted-stdlib bloat track (#3141 → #3204) converts hand-emitted
`Instr[]` Math builtins in `src/codegen/math-helpers.ts` into TS source in
`src/stdlib/math.ts`, compiled through our own IR driver — deleting hand
assembly (net −LOC) and dogfooding the compiler.

Per #3226, `Math.atan2` was the **only remaining Math core with no dialect
gap**: it is pure f64 (a quadrant ladder over `Math_atan`), just 2-arg, so it
flows through the already-landed #3161 generalized `emitSelfHostedFunc` typed
path (`paramTypes: [F64, F64]`) — no new intrinsics needed. The other
still-hand-emitted cores stay: `exp`/`pow`/`log10` need the #3226 intrinsics
groundwork (i32 bit-ops / reinterpret / sound `f64.nearest`); `random` is a
host RNG import.

## What shipped

- `src/stdlib/math.ts`: `ATAN2_SOURCE` + `ATAN2_BUILTIN` — the atan2 body as
  ordinary TS source in the IR-claimable subset. `StdlibMathBuiltin` gained an
  `arity?: 1 | 2` field (default 1); atan2 sets `arity: 2`.
- `src/codegen/stdlib-selfhost.ts`: `mathBuiltinDef` honors `arity` →
  `paramTypes: [F64, F64]` for the binary builtin (callees stay unary f64).
- `src/codegen/math-helpers.ts`: the ~110-line hand `buildAtan2Body` +
  registration deleted, replaced by a one-line `emitSelfHostedMathFunc` call
  at the same emission slot. Net **−51 src LOC**.
- `tests/issue-3233.test.ts`: every special arm (quadrant signs, sign-of-zero,
  NaN, ±Inf × ±Inf corners) pinned exactly + general-path accuracy, host and
  standalone (no host imports).

### Dialect encodings of the hand ops (bit-identical)

- `copysign(mag, y)` with `mag >= 0` → `y < 0 ? -mag : mag` (finite-nonzero-y
  branches; sign of y is its sign bit) and `1 / y < 0 ? -mag : mag` in the
  `y === 0` branch (probing the sign of ±0 via `1/±0 = ±Infinity`);
- `copysign(0, y)` for finite nonzero y → `y * 0` (IEEE multiply carries the
  sign: `(-5)*0 = -0`, `5*0 = +0`);
- `x === ±Infinity` → `x > MAX_VALUE` / `x < -MAX_VALUE`; `|y| === Infinity` →
  `Math.abs(y) > MAX_VALUE` (NaN already returned earlier).

The general path calls the SAME self-hosted `Math_atan`, so the result is
bit-identical to the deleted hand version (they share that polynomial), not
merely to JS `Math.atan2`.

## Proof

1. **Bit-exactness**: an 11,664-case sweep (108 × 108 values covering every
   special arm — ±0, NaN, ±Inf, MAX/MIN_VALUE, subnormals, the atan
   reduction thresholds — plus 80 random values across 60 orders of magnitude)
   compared branch-vs-`main`-built control by raw f64 bit pattern: **ZERO
   mismatches**.
2. **Containment**: programs NOT using `Math.atan2` (no-math, sin/cos/tan,
   log/pow/exp/log10/log2, atan/asin/acos, the derived family) produce
   **byte-identical** binaries branch-vs-main (SHA-compared). Only the
   atan2-using program's binary changes (expected).
3. **Both pure-Wasm lanes**: `target: standalone` and `target: wasi` compile
   with **zero** host imports.
4. `tests/issue-3233.test.ts` (2), `tests/math-inline.test.ts` +
   `tests/issue-3141.test.ts` (51) all green; loc-budget gate OK (net −51);
   IR-fallback gate OK (no bucket growth).

## Result

`math-helpers.ts` now hand-emits only the four true dialect-gap / host cores
(exp, pow, log10, random). All clean-slice self-host units are exhausted —
the next −LOC on the Math family requires the #3226 intrinsics groundwork.
