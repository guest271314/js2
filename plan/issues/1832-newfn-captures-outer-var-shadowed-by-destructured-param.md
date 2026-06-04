---
id: 1832
title: "compileNewFunctionExpression captures outer var shadowed by a destructured param"
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
# #1832 — destructured param shadowing fails in new-function-expression

## Symptom
`function({a}){ return a }` where an outer scope also has `a`: the body reads the
captured outer `a` instead of the param bound by destructuring.

## Location
`src/codegen/expressions/new-super.ts:1084`: `isOwnParam` is
`parameters.some(p => ts.isIdentifier(p.name) && p.name.text === name)` — binding
patterns never match, so the name is added to `captures`.

## Fix
Use `collectBindingPatternNames`/`isOwnParamName` (already exported from
closures.ts) instead of the identifier-only check.

