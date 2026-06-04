---
id: 1824
title: "super used as a value returns the wrong static ValType (local indexing bug)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1824 — `super` used as a value returns the wrong static type

## Symptom
A bare `super` used as a value emits the correct `local.get` but reports the type
of an unrelated local (or undefined → externref), which can mis-drive downstream
coercion.

## Location
`src/codegen/expressions.ts:1249`: `const selfType = fctx.locals[selfIdx]` where
`selfIdx = localMap.get("this")`. The correct convention (ThisKeyword branch at
`:861-865`) is `fctx.params[selfIdx]` when `selfIdx < fctx.params.length`. `this`
is param 0, so `fctx.locals[0]` is a non-param local.

## Fix
Mirror the ThisKeyword indexing (params array for param indices).

