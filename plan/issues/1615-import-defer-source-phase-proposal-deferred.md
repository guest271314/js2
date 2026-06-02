---
id: 1615
title: "deferred: import.defer / import.source phase proposal not supported (Stage-N) — tracking"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: low
feasibility: hard
task_type: feature
area: codegen
language_feature: import-defer, import-source, module-phase-imports
goal: compiler-correctness
sprint: Backlog
es_edition: proposal
test262_count: 152
related: [1315]
---
# #1615 — import.defer / import.source phase imports (deferred proposal)

## Problem

152 test262 tests fail with `compile_error` because the deferred-import /
source-phase-import proposal syntax is not supported:

```
SyntaxError: import.defer(...) is not supported (Stage N proposal — import-defer / source-phase)   (62)
SyntaxError: import.source(...) is not supported (Stage N proposal — import-defer / source-phase)   (90)
```

These are valid-syntax tests for the TC39 **import-defer** and
**source-phase-imports** proposals (`import.defer(...)`, `import.source(...)`,
`import defer` / `import source` declarations). The compiler emits a clean
unsupported-feature SyntaxError rather than crashing.

This is **deferred / proposal-tracking only** — these are not yet
standardised ECMAScript. It is intentionally low priority.

## Failing test examples

- `test/language/expressions/dynamic-import/syntax/valid/nested-async-arrow-function-await-import-defer-script-code-valid.js`
- `test/language/expressions/dynamic-import/catch/nested-arrow-import-catch-import-source-specifier-tostring-abrupt-rejects.js`

## Relationship to #1315

#1315 tracks the *negative* (early-error) side — proposal tests with
`negative: { phase: parse, type: SyntaxError }` that should be rejected. This
issue tracks the *positive* valid-syntax tests that can only pass once the
phase-import proposal is actually implemented. Both stay deferred until the
proposal advances.

## Acceptance criteria (deferred)

- Tracking only. No implementation expected until the proposal reaches a
  later stage and is prioritised. Revisit if module-phase imports are added
  to the goal graph.
