---
id: 1825
title: "i32 fast-mode % emits trapping i32.rem_s (x % 0 traps instead of NaN)"
status: ready
created: 2026-06-04
updated: 2026-06-04
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
`src/codegen/binary-ops.ts:2337-2339` (`compileI32BinaryOp` PercentToken →
`i32.rem_s`), reachable via the i32 fast-path dispatch (`isDivOrPow` excludes `/`
and `**` but **not** `%`).

## Spec
ECMAScript §6.1.6.1.6 Number::remainder (d=0 ⇒ NaN; no overflow concept).

## Fix
Exclude `%` from the i32 fast path (route to `emitModulo`), or guard the i32 path
with `b==0` and `INT_MIN/-1` checks.

