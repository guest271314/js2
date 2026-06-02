---
id: 1609
title: "codegen: non-literal spread argument in new-expression not supported"
status: blocked
created: 2026-05-24
updated: 2026-05-27
priority: medium
feasibility: medium
task_type: feature
area: codegen
language_feature: spread, new-expression
goal: compiler-correctness
sprint: Backlog
blocked_on: [1620, 1633]
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

## Investigation 2026-05-27 (dev-1604) — root-cause hypothesis is wrong; BLOCKED on iterator bridge

The "reuse call-expression spread lowering" hypothesis underestimates the work.
Findings from inspecting the actual failing test262 files
(`language/expressions/new/spread-*`):

1. **Every** failing test invokes an anonymous `new function() { ... }` with
   **no formal parameters** and reads `arguments.length` / `arguments[i]`.
   So there is no formal-param subset to expand a spread into — the spread
   result must populate a **dynamic-length `arguments` object**.
   `compileNewFunctionExpression` (src/codegen/expressions/new-super.ts:854)
   builds a *static* `arguments` vec from a **compile-time-fixed** formal/flat
   arg count (lines 1064-1078). A runtime-variable spread length breaks that
   assumption outright.

2. The non-literal sources are custom `Symbol.iterator` objects
   (`spread-sngl-iter`, `spread-mult-iter`) and assignment expressions / vars
   holding plain arrays (`spread-sngl-expr` = `...(target = source)`), plus a
   block of error tests (`spread-err-*-itr-step/value/get-*`) that require
   driving an arbitrary iterator and propagating a **mid-iteration throw**.

3. `compileSpreadCallArgs` (src/codegen/expressions/extern.ts:404) — the
   lowering the issue suggested reusing — only expands a **vec-struct
   (compiled-array) source into a fixed param count**. It does NOT drive a
   general `Symbol.iterator`. Confirmed: even the *plain call* path emits
   invalid Wasm for `f(...customIterObj)` ("not enough arguments on the stack").
   Only a typed-array variable (`number[]`) spread compiles to valid Wasm today.

**Conclusion**: #1609 needs (a) a runtime iterator-protocol driver producing a
dynamic-length argv, and (b) a dynamic-argv lifted constructor to build
`arguments`. That is the **same iterator-bridge infrastructure as #1620 /
#1633** (the latter escalated NEEDS-SPEC for exactly this). This issue is
**blocked on #1620 / #1633**, not a localized dev fix. Re-route after the
iterator bridge lands; reassess then whether the array-literal/typed-array
subset can be carved off as a partial win.
