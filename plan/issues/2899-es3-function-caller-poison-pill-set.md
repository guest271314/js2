---
id: 2899
title: "≤ES3: Function `.caller` poison-pill must throw TypeError on set (`bound.caller = {}`)"
status: ready
priority: high
sprint: current
created: 2026-06-30
feasibility: medium
task_type: bug
area: runtime
es_edition: 3
language_feature: function-caller
goal: spec-completeness
related: [2897]
---

# #2899 — bound-function `.caller` poison-pill does not throw on assignment

One of the **8 tests blocking 100% ≤ES3 conformance**.

## Failing test
`test/language/statements/function/13.2-30-s.js`

→ **`returned 5 — assert #4 at L22: assert.throws(TypeError, function() { bound.caller = {}; })`** — assigning to `.caller` should throw `TypeError`, but doesn't.

## What it checks
`Function.prototype.caller` / `Function.prototype.arguments` are "poison-pill" accessor properties: their `[[Get]]`/`[[Set]]` throw a `TypeError` (especially on a bound/strict function). `bound.caller = {}` must throw. We currently allow the assignment (the property isn't a throwing accessor).

## Root-cause direction
The function-object property model needs `caller`/`arguments` realized as poison-pill accessors (throwing getter+setter) on the relevant functions (bound functions, strict functions). Look at how function objects expose `caller`/`arguments` and the assignment path for those keys. (Technically an ES5-strict semantic that the edition heuristic buckets as ≤ES3.)

## Acceptance
- `bound.caller = {}` (and `.arguments` set/get) throw `TypeError`; the test passes.
- No regression in normal function-property tests.
