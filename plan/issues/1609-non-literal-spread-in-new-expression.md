---
id: 1609
title: "codegen: non-literal spread argument in new-expression not supported"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
task_type: feature
area: codegen
language_feature: spread, new-expression
goal: compiler-correctness
sprint: Backlog
es_edition: es2015
test262_count: 18
---
# #1609 — Non-literal spread in `new` expression unsupported

## Problem

18 test262 tests fail with:

```
new FunctionExpression with non-literal spread not supported
```

All are `language/expressions/new` spread tests where the constructor is
invoked with `new F(...iterable)` and the spread operand is a non-array-literal
(an iterator, a variable, an expression that throws mid-iteration).

## Failing test examples

- `test/language/expressions/new/spread-sngl-expr.js`
- `test/language/expressions/new/spread-sngl-iter.js`
- `test/language/expressions/new/spread-err-sngl-err-itr-step.js`

## Root-cause hypothesis

Spread-in-`new` codegen only handles the array-literal fast path
(`new F(...[a, b])`) and bails on the general iterator-protocol spread. The
call-expression path already supports general spread; the `new`-expression
path in `src/codegen/expressions.ts` needs the same iterator-protocol
expansion (build the argument array from the iterator, then apply to the
constructor). Reuse the existing call-spread lowering for the construct path.

## Acceptance criteria

- `new F(...iter)` with a non-literal iterable compiles.
- >=14 of the 18 tests move off `compile_error`.
