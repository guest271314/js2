---
id: 2898
title: "≤ES3: `yield` as assignment target should be an early SyntaxError (currently compiles)"
status: ready
priority: high
sprint: current
created: 2026-06-30
feasibility: medium
task_type: bug
area: codegen
es_edition: 3
language_feature: early-error
goal: spec-completeness
related: [2897]
---

# #2898 — `yield`-expression as assignment target is missing its early SyntaxError

One of the **8 tests blocking 100% ≤ES3 conformance**.

## Failing test
`test/language/expressions/assignmenttargettype/direct-yieldexpression-0.js`

→ **`expected parse/early SyntaxError but compiled and instantiated successfully`** — we accept a program the spec rejects at parse time.

## What it checks
A `YieldExpression` has AssignmentTargetType "invalid", so using it as an assignment target is an **early SyntaxError** (negative test, `phase: parse`). We currently compile + instantiate it instead of rejecting it.

## Root-cause direction
Early-error / negative-test handling: the parser or the pre-codegen early-error pass does not flag a `yield`-expression in assignment-target position. Find where AssignmentTargetType invalidity is (or isn't) enforced — the negative `phase: parse` test expects a `SyntaxError` raised before compilation. Note this is an **edition-heuristic ≤ES3 bucket** (yield is ES6); it counts toward the project's ES3 metric but is an early-error/generator concern.

## Acceptance
- The test raises the expected early `SyntaxError` and is recorded as pass.
- No regression in valid `yield`/generator tests.
