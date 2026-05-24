---
id: 1606
sprint: 56
title: "codegen crash: 'Cannot read properties of undefined (reading declarations)' on object-literal expressions"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
task_type: bug
area: codegen
language_feature: object-literals
es_edition: multi
goal: compiler-correctness
test262_count: 8
---

# #1606 — Internal compiler crash on object-literal expressions

## Problem

8 test262 tests crash the compiler:

```
Internal error compiling expression: Cannot read properties of undefined (reading 'declarations')
```

All 8 are `language/expressions/object` (the ES5 `11.1.5` object-initializer
section). The compiler dereferences `.declarations` on an undefined node while
compiling an object literal — an outright crash, not a graceful
unsupported-feature error.

## Failing test examples

- `test/language/expressions/object/11.1.5_7-3-2.js`
- `test/language/expressions/object/11.1.5-0-1.js`
- `test/language/expressions/object/11.1.5_4-4-a-3.js`

## Root-cause hypothesis

Object-literal codegen in `src/codegen/expressions.ts` (or `literals.ts`)
resolves a property's symbol/type and reads `symbol.declarations` (or
`type.symbol.declarations`) without a null guard. Some object-literal property
shapes in these ES5 tests (getter/setter pairs, duplicate keys, accessor
descriptors) produce a symbol with no `declarations`. Add a guard / fallback
type-resolution path.

## Acceptance criteria

- The three example tests compile without an internal crash.
- All 8 tests move off `compile_error`.
