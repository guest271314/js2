---
id: 1818
title: "i32/boolean parameter default fires on a legitimate 0 / false argument"
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
# #1818 — i32/boolean parameter default fires on `0` / `false`

## Symptom
- `function f(b=true){return b}; f(false)` → `true`.
- `function f(n:number=5){return n}; f(0)` (n narrowed to i32) → `5`.

## Location
`src/codegen/closures.ts:767-770` and `src/codegen/class-bodies.ts:1076-1083`
use `i32.eqz` as the "argument missing" sentinel; booleans resolve to i32
(`type-mapper.ts:55`). The f64 path correctly uses a NaN self-test, and the
array/object-pattern paths already *skip* the check for i32 (closures.ts:714).

## Spec
Default applies only when the argument is `undefined`.

## Fix
Don't emit a default check for plain i32/boolean params; thread an explicit
arg-present flag instead of reusing `0` as the missing sentinel.

