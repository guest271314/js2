---
id: 2897
title: "≤ES3: `arguments` as assignment target crashes (null-deref)"
status: ready
priority: high
sprint: current
created: 2026-06-30
feasibility: medium
task_type: bug
area: codegen
es_edition: 3
language_feature: arguments
goal: spec-completeness
related: [2676, 2667]
---

# #2897 — `arguments` identifier-reference assignment target null-derefs

One of the **8 tests blocking 100% ≤ES3 conformance** (ES3 edition currently 266/274 ≈ 97%).

## Failing test
`test/language/expressions/assignmenttargettype/simple-basic-identifierreference-arguments.js`

→ **`L41:3 dereferencing a null pointer [in test()]`** — a compiler/runtime **crash**, not a wrong value.

## What it checks
`arguments` is a valid `SimpleAssignmentTarget` (AssignmentTargetType = "simple") in non-strict code, so an assignment whose target is the `arguments` identifier reference must compile and run. The test drives the assignment-target-type machinery using `arguments` as the LHS.

## Root-cause direction
The codegen path for an assignment whose LHS resolves to the `arguments` binding dereferences a null pointer — the `arguments` object/local is likely not materialized on the **assignment-target (lvalue)** path the way it is on the read path. Look at identifier-reference assignment lowering (`src/codegen/expressions/assignment.ts`) and how `arguments` is bound as an lvalue (the eager-arguments-materialization site).

## Acceptance
- The test compiles + runs without the null-deref and passes.
- No regression in other `arguments`/assignment tests.
