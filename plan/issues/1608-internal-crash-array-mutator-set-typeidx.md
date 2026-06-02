---
id: 1608
title: "codegen crash: 'Cannot set properties of undefined (setting typeIdx)' on Array push/pop/shift/join/unshift"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: array-mutator-methods
goal: compiler-correctness
sprint: 56
es_edition: multi
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

## Root cause (actual)

Not in the Array mutator intrinsic. The crash is in
`compileObjectLiteralForStruct` (`src/codegen/literals.ts`). These tests assign
many sibling object literals with the same method names to a property
(`obj.length = { valueOf() {...} }`, repeated). Sibling literals that share a
struct dedup-key share the same method `fullName` (e.g. `__anon_0_valueOf`), so
they share one `ctx.funcMap` entry. The first literal recorded a funcIdx that —
after late-import index shifting (`addUnionImports`) — fell into the import
range. A later sibling looked the entry up and computed
`localIdx = existingFuncIdx - ctx.numImportFuncs`, which went **negative** (e.g.
54 − 79 = −25). `ctx.mod.functions[-25]` was `undefined`, and writing
`.typeIdx` on it threw `Cannot set properties of undefined`.

## Fix

`src/codegen/literals.ts` — guard the funcMap-slot resolution: when the
recorded funcIdx resolves to an out-of-range / undefined function slot, treat it
as "no existing function" and synthesize a fresh one (overwriting the stale
funcMap entry with the new valid index). Mirrors the existing
`if (!existingFunc) continue;` guard in the same file's fork-decision pre-pass.

## Test Results (2026-05-27, branch issue-1608-array-typeidx)

All five A2_T* tests now compile (off `compile_error`); they land on `fail`
(runtime assertion — out of scope here, generic-array-like semantics):

- push/S15.4.4.7_A2_T3 — compile_error → fail
- shift/S15.4.4.9_A2_T5 — compile_error → fail
- join/S15.4.4.5_A2_T4 — compile_error → fail
- pop/S15.4.4.6_A2_T4 — compile_error → fail
- unshift/S15.4.4.13_A2_T1 — compiles (fail)

Unit test `tests/issue-1608.test.ts` reproduces via `wrapTest` + the full
test262 preamble (fails without the fix, passes with it). No regressions in
anon-struct / arguments-object / array-prototype-methods / class-methods /
array-methods suites (identical pre-existing failure counts with and without
the fix).
