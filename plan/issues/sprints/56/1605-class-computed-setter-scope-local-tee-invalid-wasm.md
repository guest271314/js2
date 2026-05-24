---
id: 1605
title: "codegen: class computed-property-name / setter param-scope emits invalid wasm (local.tee externref mismatch)"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 6
related: [1522]
---
# #1605 — Class computed-name / setter scope local.tee type mismatch

## Problem

6 test262 tests fail with `invalid Wasm binary`:

```
local.tee[N] expected type externref, found ... (or vice versa)
```

All 6 are in `language/statements/class` and `language/expressions/class`,
specifically:
- computed-property-name accessors built from `null`
  (`cpn-class-decl-accessors-computed-property-name-from-null`)
- setter param-body var-close scope tests
  (`scope-setter-paramsbody-var-close`, `scope-static-setter-paramsbody-var-close`)

The failing function is `test`. A `local.tee` writes/reads a local declared
with a type that doesn't match the value being tee'd — an externref value into
a non-externref local, or the reverse — in the class member scope-setup code.

## Failing test examples

- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-null.js`
- `test/language/statements/class/scope-setter-paramsbody-var-close.js`
- `test/language/statements/class/scope-static-setter-paramsbody-var-close.js`

## Root-cause hypothesis

The class-member lowering (`src/codegen/` class/accessor codegen) allocates a
local for a computed property key or a setter parameter with one declared type
but tees a value of a different type into it. For the computed-name-from-null
case the key is null/externref while the local is typed for the resolved key;
for the setter param-scope cases the var-close scope copy mismatches. Audit the
local-type declaration vs. the tee'd value type in computed-key evaluation and
setter parameter scope copy-out.

## Acceptance criteria

- The three example tests compile to valid Wasm.
- All 6 tests move off `compile_error`.
