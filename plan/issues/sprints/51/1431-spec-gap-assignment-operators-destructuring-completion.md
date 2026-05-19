---
id: 1431
sprint: 51
title: "spec gap: assignment operators — destructuring completion, defaults, and compound side effects"
status: ready
created: 2026-05-11
updated: 2026-05-11
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: assignment, destructuring
goal: spec-completeness
related: [805, 1268, 1372, 1396, 1429]
---
# #1431 - Assignment operators: destructuring completion and compound side effects

## Problem

Spec §13.15 is still partial after #1268. The current compliance report shows
`604 / 1017` passing with 363 failures and 50 skips. The remaining failures are
not only `??=` index-signature cases; they include destructuring assignment
completion propagation and compound-assignment evaluation order.

Known residual patterns:

- Default initializers in assignment patterns lose the original thrown value or
  completion context.
- Iterator and property access during destructuring assignment do not always
  match `IteratorDestructuringAssignmentEvaluation`.
- Compound member assignment can observe getter/key side effects more than once
  instead of using the spec's single-reference evaluation.

## Acceptance criteria

1. Add focused tests for assignment-pattern defaults that throw and assert the
   original error object is observed.
2. Add focused tests for computed member compound assignment where key/getter
   side effects must run once.
3. `language/expressions/assignment/dstr-*` and compound member-assignment
   test262 buckets improve without regressing #1268.
4. Update `spec-compliance/sec-13.15.md` with the new pass/fail count after the
   focused fix lands.

## Files to inspect

- `src/codegen/assignments.ts`
- `src/codegen/destructuring.ts`
- `src/codegen/destructuring-params.ts`
- `src/codegen/property-access.ts`
- `tests/issue-1431.test.ts`
