---
id: 1825
title: "i32 fast-mode % emits trapping i32.rem_s (x % 0 traps instead of NaN)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: codegen
goal: compilable
sprint: 59
---
# #1825 — i32 fast-mode `%` emits trapping `i32.rem_s`

## Symptom
In fast / native-i32 mode, `a % b` with `b == 0` traps (Wasm), and
`-2147483648 % -1` traps. JS yields `NaN` and `0` respectively.

## Location
`src/codegen/binary-ops.ts` (`compileI32BinaryOp` PercentToken →
`i32.rem_s`), reachable via the i32 fast-path dispatch (`isDivOrPow` excludes `/`
and `**` but **not** `%`).

## Spec
ECMAScript §6.1.6.1.6 Number::remainder (d=0 ⇒ NaN; no overflow concept).

## Fix
Routed the `%` i32 fast path through a new `emitSafeI32Rem(fctx)` helper in
`binary-ops.ts`. It guards both trapping cases of `i32.rem_s`:
- `b == 0` → emit `0` (JS yields NaN; i32 fast mode has no NaN representation,
  and the i32 truncation of NaN is 0).
- `a == INT_MIN && b == -1` → emit `0` (the mathematically-correct result; bare
  `i32.rem_s` traps on signed overflow here).
Otherwise emits `i32.rem_s` as before. Result type stays `i32` so no downstream
signature changes.

## Test Results
`tests/issue-1825.test.ts` — i32 fast-mode modulo block (5 cases): normal `%`,
negative-dividend sign, `% 0` (returns 0, no trap), `INT_MIN % -1` (returns 0,
no trap), and `% 0` with computed operands inside a loop. All pass.
