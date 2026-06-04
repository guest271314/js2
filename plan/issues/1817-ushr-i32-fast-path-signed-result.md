---
id: 1817
title: ">>> in i32 fast path produces a signed result (negative for high-bit values)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1817 — `>>>` i32 fast path produces a signed result

## Symptom
`(x >>> 0)` where `x` has the high bit set yields a *negative* float instead of
the correct large unsigned value (0..2^32-1).

## Location
`src/codegen/binary-ops.ts:1318`/`:1334`. `isI32PureExpr` accepts `>>>` as
i32-pure; the i32 result is later widened with `f64.convert_i32_s`
(type-coercion.ts:1330). The non-fast path (`compileBitwiseBinaryOp`, `:2548`)
correctly uses `f64.convert_i32_u`.

## Spec
ToUint32 — `>>>` result is unsigned.

## Fix
Exclude `GreaterThanGreaterThanGreaterThanToken` from the i32-pure fast path, or
emit `f64.convert_i32_u` when the consumer wants f64.

