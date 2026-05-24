---
id: 1614
sprint: 56
title: "codegen: Set set-method intrinsics missing ('Cannot find method size/...' on parent class Set)"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: low
feasibility: medium
task_type: feature
area: codegen
language_feature: set-methods
es_edition: es2024
goal: compiler-correctness
test262_count: 7
related: [1103]
---

# #1614 — Set composition methods not resolved on subclass receivers

## Problem

7 test262 tests fail with:

```
Cannot find method 'size' on parent class 'Set'
```

All are the ES2024 Set-composition methods invoked on subclass receivers:
`union`, `isDisjointFrom`, `isSupersetOf`, `symmetricDifference`,
`intersection`, `difference`, `isSubsetOf` (the
`*/subclass-receiver-methods.js` suite). The implementation of these methods
calls the abstract `GetSetRecord` steps which read the `size` getter and the
`has`/`keys` methods off the argument; the compiler cannot resolve `size`
(and the other set-record members) on the `Set` parent class.

## Failing test examples

- `test/built-ins/Set/prototype/union/subclass-receiver-methods.js`
- `test/built-ins/Set/prototype/isDisjointFrom/subclass-receiver-methods.js`
- `test/built-ins/Set/prototype/symmetricDifference/subclass-receiver-methods.js`

## Root-cause hypothesis

The Set-method intrinsics (see #1103 wasm-native Map/Set) reference the `size`
accessor and `has`/`keys` methods via a `parent class 'Set'` lookup that does
not register the `size` getter (it is an accessor, not a data method) on the
intrinsic Set shape. Register the Set `size` accessor and the
`has`/`keys`/`values` methods so the GetSetRecord abstract operation resolves.

## Acceptance criteria

- The Set-composition methods resolve `size`/`has`/`keys` on receivers.
- >=5 of the 7 tests move off `compile_error`.
