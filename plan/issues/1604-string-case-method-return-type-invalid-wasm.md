---
id: 1604
title: "codegen: String case methods (toUpperCase/toLowerCase/toLocale*) return i32 into f64 comparison — invalid wasm"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: string-methods
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 8
related: [1105, 1522]
---
# #1604 — String case-conversion method result type mismatch

## Problem

8 test262 tests fail with `invalid Wasm binary`:

```
f64.ne[0] expected type f64, found call of type i32
```

All 8 are `built-ins/String`, specifically the case-conversion methods:
`toUpperCase`, `toLowerCase`, `toLocaleUpperCase`, `toLocaleLowerCase`.

The compiled `test` function calls the string-case method (whose codegen emits
an `i32`-typed result — likely a string-array ref index or a stale i32 temp)
and then feeds it directly into an `f64.ne` comparison, which the validator
rejects.

## Failing test examples

- `test/built-ins/String/prototype/toUpperCase/S15.5.4.18_A1_T9.js`
- `test/built-ins/String/prototype/toUpperCase/S15.5.4.18_A1_T4.js`
- `test/built-ins/String/prototype/toLocaleUpperCase/S15.5.4.19_A1_T4.js`

## Root-cause hypothesis

The String case-method intrinsic in `src/codegen/` (string method lowering,
see #1105) declares or returns an `i32` result type where the surrounding
expression expects an `externref`/f64 string value. When the test compares the
result with `!=`, `coerceType` is not invoked (or invoked against the wrong
source type) before `f64.ne`. Audit the return-type registration of the
case-conversion methods so their result is a string ref that coerces correctly
in numeric/equality contexts.

## Acceptance criteria

- The three example tests compile to valid Wasm.
- All 8 tests move off `compile_error`.
