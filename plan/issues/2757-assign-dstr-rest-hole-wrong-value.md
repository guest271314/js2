---
id: 2757
title: "Assignment-destructuring (expressions/assignment): rest element + undefined/hole binds wrong value / 'array too large' trap"
status: ready
created: 2026-06-28
updated: 2026-06-28
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
parent: 2669
related: [2669]
sprint: current
---
# #2757 — assignment-destructuring rest/hole wrong value

Carved from the #2669 destructuring umbrella (sd-dstr-objdefault, 2026-06-28).
The **assignment** destructuring path (`[a, ...r] = x`, i.e.
`expressions/assignment/dstr/`) — distinct file/codegen from binding-pattern
destructuring, so independently shippable in parallel with #2756/#2758.

## Repro (verified on current `origin/main` @ #2201)

```ts
// TRAP: "requested new array is too large"  (want x === undefined)
let x: any, r: any;
[x, ...r] = [];
```
test262 (fresh single-file, FAIL):
```
language/expressions/assignment/dstr/array-rest-nested-obj-undefined-own.js
  -> returned 2 | assert #1 at L28: assert.sameValue(x, undefined)
language/expressions/assignment/dstr/array-rest-nested-obj-undefined-hole.js
  -> same
```
The rest element drained from a short/empty source mis-sizes the new array
(trap), and a present-but-`undefined` / hole element in assignment destructuring
binds the underlying value rather than `undefined`.

## Scope

- `expressions/assignment/dstr/` cluster — **149** total non-pass; this slice is
  the **rest-element + elision/hole value-binding** subset that does NOT involve
  a generator source (those route to #2566) or a custom iterable (those route to
  the iterator-protocol tail / #2662). Est net recovery: **~40–60**.
- The assignment path differs from binding patterns: the targets are arbitrary
  assignment LHS (member exprs, identifiers), not fresh bindings — confirm the
  rest-collection and the hole→undefined semantics in the assignment lowering.

## Root-cause pointer

- Assignment-destructuring lowering lives in the expression/assignment codegen
  (grep `compileArrayAssignmentDestructuring` / array-assignment rest handling in
  `src/codegen/expressions*`); the rest collection sizes a new array from the
  remaining iterator/vec length — verify the empty/short-source length math and
  the OOB→undefined sentinel for non-rest holes.

## Acceptance criteria

- `[x, ...r] = []` ⇒ `x === undefined`, `r` is an empty array (no trap).
- `array-rest-nested-obj-undefined-own` / `-undefined-hole` flip fail→pass.
- No regression in passing assignment-destructuring cases.
- Guard test `tests/issue-2757.test.ts`.

## Note

Verify-first on current main before implementing — confirm the exact failing
subset is non-generator/non-custom-iterable (deep-trace the rest length math).
Owner-claim is released on the orphan ref (reserved only to allocate the id) —
claim it fresh via `claim-issue.mjs 2757 ttraenkler/<you> --branch …`.
