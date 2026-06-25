---
id: 2669
title: "ES2015: destructuring correctness residual umbrella (~696 fails — iterator-close, defaults, holes, rest across for-of/assignment/binding/params)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
related: [1642, 2566, 1556, 1454, 2203, 2032, 796]
sprint: 66
---
# #2669 — ES2015 destructuring correctness residual umbrella

## Edition / impact

- **Edition:** ES2015.
- **Fail count:** **~696** — the single largest ES2015 cluster (and the largest
  cross-cutting theme in the whole suite).
- Sub-breakdown (by `/dstr/` path + `destructuring-*` feature tag):
  - `for-of/dstr` — **247**
  - `expressions/assignment` (assignment destructuring) — **131**
  - binding patterns (`let`/`const`/`var` dstr) — **91**
  - function-param dstr — **63**
  - generator/yield-in-dstr — **63**
  - object-method (`expressions/object/dstr`, class method params) — **55**
  - arrow-function dstr — **30**
  - other — **16**

Residual after a long line of done destructuring issues (#1454, #2203, #2032,
#796, #2587). Each landed a slice; this umbrella tracks the remaining tail so it
can be sliced and burned down deliberately rather than rediscovered ad hoc.

## Problem — recurring sub-patterns

1. **IteratorClose on abrupt completion** — when a destructuring step throws or
   an array pattern doesn't consume the whole iterator, `IteratorClose` must run
   the iterator's `return()`. Tests:
   `for-of/dstr/array-*-iter-*-close-*.js`, `array-elem-iter-nrml-close-err.js`.
   (Overlaps the open #1642 — for-of body-throw IteratorClose.)
2. **Default-init evaluation** — initializer evaluated **only** when the element
   is `undefined`, exactly once, with correct `initCount`/side-effect order.
   Tests: `*-ptrn-elem-id-init-skipped.js`, `*-dflt-*`.
3. **Elision / holes** — `[, , x]` must advance the iterator past elided slots
   without binding. Tests: `*-ary-ptrn-elem-ary-elision-*`.
4. **Rest element** `[...r]` / `{...r}` — must drain remaining iterator / copy
   remaining own-enumerable props; nested rest patterns.
5. **Generators as the iterated value** — eager-buffer over-consumption gives
   wrong yield/side-effect counts (open #2566).
6. **Function/method/arrow param patterns** — struct-field type mismatches and
   null-deref in param destructuring (open #1556).

Failure signatures: `assert.sameValue(initCount, 0)`, `throw new Test262Error()`
after a close assertion, `Cannot destructure 'null' or 'undefined'`,
`it.next is not a function`, null-deref in `test()`.

## Failing-test cluster (examples)

```
language/statements/for-of/dstr/array-elem-iter-nrml-close-err.js
language/statements/for-of/dstr/let-obj-ptrn-prop-id-init-skipped.js
language/statements/for-of/dstr/const-ary-ptrn-elem-ary-elem-init.js
language/expressions/assignment/dstr/array-elem-trlg-iter-elision-iter-abpt.js
language/expressions/object/dstr/meth-ary-ptrn-elem-ary-elision-init.js
language/statements/class/dstr/private-meth-ary-ptrn-elem-ary-elision-init.js
```

## Acceptance criteria

- Net reduction of the destructuring `/dstr/` failing set by **≥ 400 tests**
  across the sub-clusters above (umbrella target; slices below ship individually).
- IteratorClose runs on abrupt completion and on partial consumption.
- Default initializers evaluate iff element is `undefined`, exactly once.
- Elisions advance the iterator without binding; rest elements drain correctly.
- No regression in currently-passing destructuring tests.

## Slicing plan (route to architect for the iterator-protocol slice)

- **Slice A — IteratorClose / abrupt-completion** (folds in open #1642). hard.
- **Slice B — default-init evaluation + elision/hole iteration** (medium).
- **Slice C — generator-as-source over-consumption** (open #2566). medium.
- **Slice D — param-pattern struct-field type mismatch** (open #1556). medium.

Keep #1642, #2566, #1556 as the concrete sub-issues; this umbrella tracks the
aggregate and the remaining un-issued tail (binding patterns, object-method
params, arrow params).
