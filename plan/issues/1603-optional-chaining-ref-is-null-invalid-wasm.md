---
id: 1603
title: "codegen: optional-chaining short-circuit emits invalid wasm (ref.is_null expected i32, found ref)"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: optional-chaining
goal: compiler-correctness
sprint: 56
es_edition: es2020
test262_count: 8
related: [1522]
---
# #1603 — Optional-chaining short-circuit produces invalid wasm

## Problem

8 test262 tests fail with `invalid Wasm binary`:

```
ref.is_null[N] expected type i32, found ... (ref) ...
```

Concentrated in `language/expressions/optional-chaining` (call-expression,
short-circuiting, iteration for-of type-error), plus one `built-ins/ArrayBuffer`.

The optional-chaining short-circuit lowering emits a `ref.is_null` guard whose
operand/result is wired into an i32 context incorrectly: the validator sees a
ref where it expects i32 (or vice versa) at the null-check that decides whether
to short-circuit the `?.` chain.

## Failing test examples

- `test/language/expressions/optional-chaining/call-expression.js`
- `test/language/expressions/optional-chaining/short-circuiting.js`
- `test/language/expressions/optional-chaining/iteration-statement-for-of-type-error.js`

## Root-cause hypothesis

The `?.` desugaring in `src/codegen/expressions.ts` emits `ref.is_null` to test
the base value, but the surrounding select/branch consumes the result as the
wrong type — likely the i32 boolean produced by `ref.is_null` is fed to a path
expecting the ref itself, or the base was already unboxed to f64 and
`ref.is_null` is applied to a non-ref. Audit the short-circuit branch
construction to keep the null-test boolean (i32) and the chained value (ref)
on separate, correctly-typed edges.

## Acceptance criteria

- The three example tests compile to valid Wasm.
- All 8 tests move off `compile_error`.
