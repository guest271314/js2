---
id: 1608
title: "codegen crash: 'Cannot set properties of undefined (setting typeIdx)' on Array push/pop/shift/join/unshift"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
task_type: bug
area: codegen
language_feature: array-mutator-methods
es_edition: multi
goal: compiler-correctness
test262_count: 5
---

# #1608 — Internal crash setting typeIdx in Array mutator codegen

## Problem

5 test262 tests crash the compiler:

```
Internal error compiling expression: Cannot set properties of undefined (setting 'typeIdx')
```

All 5 are `built-ins/Array/prototype` mutator/accessor methods invoked on a
non-array `this` value (the `A2_T*` "apply to non-array / arguments-like"
suites):

- `test/built-ins/Array/prototype/push/S15.4.4.7_A2_T3.js`
- `test/built-ins/Array/prototype/shift/S15.4.4.9_A2_T5.js`
- `test/built-ins/Array/prototype/join/S15.4.4.5_A2_T4.js`
- `test/built-ins/Array/prototype/pop/S15.4.4.6_A2_T4.js`

The codegen attempts to assign `.typeIdx` on an undefined object while lowering
the Array method — the receiver's element/array type was never resolved
(generic / non-array `this`), so the type record is undefined.

## Root-cause hypothesis

The Array mutator intrinsic lowering in `src/codegen/` builds or looks up an
array type descriptor and writes `descriptor.typeIdx = ...`, but the lookup
returns undefined when the method is `.call`/`.apply`-ed on an array-like that
is not a statically-typed array. Add a guard that resolves (or synthesizes) the
array type record before assigning `typeIdx`, falling back to the generic
array representation.

## Acceptance criteria

- The example tests compile without an internal crash.
- All 5 tests move off `compile_error`.
