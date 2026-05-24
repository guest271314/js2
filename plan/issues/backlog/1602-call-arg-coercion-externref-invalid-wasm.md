---
id: 1602
title: "codegen: call-site argument coercion emits invalid wasm (call expected externref, found f64/other)"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
task_type: bug
area: codegen
language_feature: type-coercion, call-expression
es_edition: multi
goal: compiler-correctness
test262_count: 39
related: [1522]
---

# #1602 — Call-site argument coercion produces invalid wasm

## Problem

39 test262 tests fail with `invalid Wasm binary` where the validator rejects a
`call` op because the argument on the stack has the wrong type for the
callee's signature:

```
call[N] expected type externref, found ... of type f64   (26 cases)
call[N] expected type externref, found ... of type f64   (13 cases, mixed externref/f64)
```

Spread across `language/expressions` (spread-obj-null, dynamic-import LHS),
`built-ins/Object`, `built-ins/Function` (toString of async methods),
`built-ins/Atomics`, `built-ins/RegExp`, `built-ins/Number`,
object method-definition, and `top-level-await` for-of.

This is **distinct from** #1522's `extern.convert_any double-wrap` cluster:
here the failure is at the **`call` op itself** — the argument was never
coerced to the parameter type (an f64 or unboxed value is passed where the
callee declares `externref`), rather than a global being double-wrapped.

## Failing test examples

- `test/language/expressions/new/spread-obj-null.js`
- `test/built-ins/Function/prototype/toString/async-method-class-expression-static.js`
- `test/language/expressions/object/method-definition/generator-length-dflt.js`
- `test/language/module-code/top-level-await/syntax/for-of-await-expr-identifier.js`

## Root-cause hypothesis

The argument-lowering path in call codegen (`src/codegen/expressions.ts` call
emission, `coerceType` in `src/codegen/type-coercion.ts`) skips the
f64→externref / value→externref coercion for certain argument shapes:
spread-into-call, generator/async trampoline params (`__obj_meth_tramp_*`),
and dynamic-import call targets. The callee signature expects `externref` but
the caller leaves the raw f64/value on the stack. Audit the per-argument
coercion to apply `__box_number` / `extern.convert_any` against the resolved
parameter type for these call paths.

## Acceptance criteria

- The four example tests compile to valid Wasm.
- >=30 of the 39 tests move off `compile_error`.
