---
id: 2654
title: "Standalone: parseFloat / Number(string) decimal fraction precision (1-ULP drift)"
status: done
completed: 2026-06-25
assignee: ttraenkler/agent-a2bb2065788d7244b
sprint: 66
priority: medium
feasibility: medium
reasoning_effort: high
task_type: conformance
area: number-parse
language_feature: global-functions
goal: standalone-mode
parent: 2160
related: [2652, 1663, 1688]
---

# #2654 — Standalone decimal-parse fraction precision

## Problem

In `--target standalone` / `--target wasi`, the pure-Wasm `parseFloat`,
`Number(string)` and `__str_to_number` helpers produced values off by ~1 ULP for
a large fraction of decimal inputs:

| input | host | standalone (before) |
|---|---|---|
| `parseFloat("0.3")` | `0.3` | `0.30000000000000004` |
| `Number("0.01")` | `0.01` | `0.010000000000000002` |
| `parseFloat("99.99")` | `99.99` | `99.99000000000001` |
| `parseFloat(".01e2")` | `1` | `1.0000000000000002` |
| `Number("123.456")` | `123.456` | `123.45600000000002` |

~44% of fractional inputs were wrong. `+"0.3"` happened to be right (the literal
is constant-folded), but every runtime string→number path (`Number(s)`,
`parseFloat(s)`, template interpolation feeding back through ToNumber) drifted.

## Root cause

`emitParseFloat` and `emitStrToNumber` (`src/codegen/parse-number-native.ts`)
accumulated the fraction as `mant += digit * 0.1^k` with `fracScale *= 0.1`.
`0.1` is not exactly representable in f64, so each fraction digit injected
rounding error, and the trailing per-step `*10`/`/10` exponent loop (`emitApplyExp`)
compounded it. (`parseInt` was unaffected — it has no fraction.)

## Fix

Both helpers now use an **exact integer mantissa**:

1. **Integer + fraction loops** accumulate every significant digit into a single
   **i64** mantissa (`mant = mant*10 + digit`), exact up to ~18 digits. The loops
   are capped at `mant < 9e17` (keeps `mant*10+9 < 2^63`): past the cap an
   integer digit is dropped but its place value preserved by bumping the decimal
   exponent (`intDrop`), and a fraction digit past the cap is dropped without
   counting (no visible effect on the rounded double). The i64 mantissa (vs an
   f64 one capped at 2^53 ≈ 16 digits) is what lets `Number("1234567890.1234567890")`
   and `9007199254740993` round correctly — an f64 mantissa corrupted those.
2. **Final scaling** (`emitApplyDecimalExp`): `totalExp = expSign*exp + intDrop -
   fracCount`. For `|totalExp| ≤ 22` it builds `pow = 10^|totalExp|` (EXACT —
   10^0..10^22 are exactly representable) and applies it in ONE correctly-rounded
   `mul`/`div`. For `|totalExp| > 22` it falls back to the incremental per-step
   `*10`/`/10` loop (`emitApplyExpResult`), which reaches subnormals / saturates
   gracefully — so extreme-exponent inputs (`1e-310`, `5e-324`, `1e308`) are **no
   worse than the pre-fix code** (those still need full Eisel-Lemire for bit-exact
   results, out of scope).

The legacy `emitApplyExp` step-loop is removed (its only callers migrated).

## Results

- **parseFloat lane: 11 → 6 gaps (+5 rows, 0 regressions)** — `S15.1.2.3_A4_T5`,
  `_A4_T6`, `_A5_T2`, `_A5_T3`, and the numeric-separator test now pass.
- **Number top-level lane: 25 → 24 gaps (+1 row, 0 regressions)** — `S9.3.1_A12`
  (`Number("12345e-6") === 0.012345`) now passes; `S9.3.1_A32`
  (`Number("1234567890.1234567890")`, 20 sig digits) was briefly regressed by an
  f64-mantissa intermediate and is fixed by the i64 mantissa.
- Net **+6 test262 rows**, zero regressions. (parseFloat's remaining
  `A1_T1/T3` "illegal cast" gaps are the ToString-of-primitive-arg issue fixed
  separately by #2652.)
- `tests/issue-2654.test.ts` — 35 cases (parseFloat + Number + wasi + regression
  guards) green. Existing parse/number/template/concat suites (95 tests) green.

## Deferred (out of scope)

- Bit-exact extreme exponents (|totalExp| > 22: `1e308`, `1e-308`, `1e300`) —
  need full Eisel-Lemire / big-integer rounding. The incremental fallback keeps
  these finite and ≤ ~1 ULP from host (same as pre-fix), so no regression.

## Test Results

Per-process host-vs-standalone fork scan + `tests/issue-2654.test.ts`: all
within-precision decimal inputs now match the host parse exactly.
