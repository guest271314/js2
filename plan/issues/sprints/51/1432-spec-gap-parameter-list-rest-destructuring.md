---
id: 1432
sprint: 51
title: "spec gap: parameter lists — rest/destructuring iterator semantics and default initializers"
status: ready
created: 2026-05-11
updated: 2026-05-11
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: parameters, destructuring
goal: spec-completeness
related: [869, 1158, 1372]
---
# #1432 - Parameter lists: rest/destructuring iterator semantics

## Problem

Spec §15.1 remains effectively not implemented in the compliance report:
`3 / 11` passing, with wasm_compile and assertion failures. #1158 fixed one
empty-pattern iterator-consumption bug, but the section still has residual
rest-parameter and destructuring-parameter gaps.

The remaining failures center on:

- Rest parameters with nested array/object binding patterns.
- Default initializers that must run only when the bound value is `undefined`.
- Iterator close/error propagation during parameter binding.
- Type mismatches from array materialization used by parameter destructuring.

## Acceptance criteria

1. Rest parameter destructuring handles nested array/object binding patterns.
2. Parameter default initializers distinguish `undefined` from `null` and other
   falsy values.
3. Iterator errors during parameter binding preserve the thrown error object.
4. The §15.1 mapped tests improve from `3 / 11` and no new wasm validation
   failures are introduced.

## Files to inspect

- `src/codegen/destructuring-params.ts`
- `src/codegen/functions.ts`
- `src/codegen/ir/destructuring.ts`
- `tests/issue-1432.test.ts`
