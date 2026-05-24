---
id: 1610
sprint: 56
title: "codegen: for-of over non-array iterables rejected ('for-of requires an array expression')"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
task_type: feature
area: codegen
language_feature: for-of, iterator-protocol
es_edition: es2015
goal: compiler-correctness
test262_count: 13
---

# #1610 — for-of over a non-array iterable is rejected at compile time

## Problem

13 test262 tests fail with:

```
for-of requires an array expression
```

The compiler only lowers `for (x of <array>)` when the iterand is statically an
array; a general iterable (object with `[Symbol.iterator]`, a generator result,
a Set/Map, a promise-producing async iterator) is rejected at compile time.

## Failing test examples

- `test/built-ins/Temporal/Duration/prototype/round/relativeto-largestunit-smallestunit-combinations.js`
- `test/built-ins/WeakRef/returns-new-object-from-constructor-with-object-target.js`
- `test/language/expressions/class/async-gen-method-static/yield-promise-reject-next-for-await-of-sync-iterator.js`

## Root-cause hypothesis

The for-of statement codegen in `src/codegen/statements.ts` has a fast path
that requires an array-typed iterand and throws otherwise instead of falling
back to the iterator protocol (`[Symbol.iterator]()` → `.next()` loop). Add the
general iterator-protocol lowering as the fallback when the iterand is not a
statically-known array. This unblocks Set/Map/generator/custom-iterable
for-of across the corpus.

## Acceptance criteria

- for-of over a non-array iterable compiles and iterates via the iterator
  protocol.
- >=10 of the 13 tests move off `compile_error`.
