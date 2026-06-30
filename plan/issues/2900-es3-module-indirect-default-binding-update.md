---
id: 2900
title: "≤ES3 (edition bucket): module indirect default-export binding update returns wrong value"
status: ready
priority: high
sprint: current
created: 2026-06-30
feasibility: hard
task_type: bug
area: codegen
es_edition: 3
language_feature: module-code
goal: spec-completeness
related: [2898]
---

# #2900 — module indirect global-binding update of a default export reads stale

One of the **8 tests blocking 100% ≤ES3 conformance** (edition-heuristic bucket — this is module/ESM code, surfaced under ≤ES3 because it lacks version frontmatter).

## Failing test
`test/language/module-code/eval-gtbndng-indirect-update-dflt.js`

→ **`returned 2`** (assertion failure — the indirectly-updated binding reads the wrong value).

## What it checks
ES module semantics: a `default` export bound indirectly (via an indirect/re-exported binding) must observe later updates to the live binding (module bindings are live, not snapshots). The test mutates the binding and asserts the indirect reference sees the new value.

## Root-cause direction
Module-code (ESM) live-binding handling for the `default` export through an indirect binding. Likely the default-export slot is read as a value copy rather than through the live module-environment binding. This is part of broader module-code support; scope to this single default-export-indirect-update case unless a shared root cause covers more `module-code/eval-gtbndng-*` tests.

## Acceptance
- The indirect default-binding update is observed; the test passes.
- No regression in other `module-code/` tests.
