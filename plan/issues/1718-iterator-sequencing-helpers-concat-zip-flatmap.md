---
id: 1718
title: "Iterator sequencing helpers (Iterator.concat / zip / zipKeyed) + Iterator.prototype.flatMap not implemented (101 fails)"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: medium
feasibility: hard
task_type: bugfix
area: codegen
language_feature: iterator-helpers
goal: test262-conformance
sprint: Backlog
es_edition: 2025
test262_fail: 101
test262_category: built-ins/Iterator
related: [1340, 1320]
---

# #1718 — Iterator sequencing helpers + Iterator.prototype.flatMap (101 fails)

## Problem

101 tests under `built-ins/Iterator/*` fail because newer iterator helpers are
unimplemented or mis-routed:

| Helper | Symptom | Approx count |
|--------|---------|------:|
| `Iterator.concat` | `Iterator helper: argument is not iterable` / `Iterator.concat: argument is not iterable` | ~20 |
| `Iterator.zip` / `Iterator.zipKeyed` | `Iterator helper: argument is not iterable` | ~50 |
| `Iterator.prototype.flatMap` | `flatMap is not a function` | ~31 |

This is **distinct from #1340** (`done` 2026-05-28), which fixed `wasm_compile`
errors in the *existing* Iterator.prototype helpers (map/filter/take/drop/etc.).
The **iterator-sequencing** static methods (`Iterator.concat`, `Iterator.zip`,
`Iterator.zipKeyed` — TC39 iterator-sequencing proposal, ES2025-era) and
`Iterator.prototype.flatMap` are either not defined or fall through to a path
that rejects valid iterables.

Note: `Array.prototype.flatMap` (#1136, done) is a different method — this is the
**Iterator** helper.

## Root-cause hypothesis

- `Iterator.concat(...items)` / `Iterator.zip(iterables)` /
  `Iterator.zipKeyed(iterables)` are missing static methods on the Iterator
  constructor; the generic "iterator helper" dispatch wrongly reports "argument
  is not iterable" because the iterable-coercion (GetIteratorFlattenable /
  GetIteratorDirect) step is not implemented for these inputs.
- `Iterator.prototype.flatMap` is absent from the Iterator prototype method
  table, so the property resolves to undefined and the call traps.

Spec:
[Iterator.prototype.flatMap §27.1.4.x](https://tc39.es/ecma262/#sec-iteratorprototype.flatmap),
[iterator-sequencing proposal (Iterator.concat / zip / zipKeyed)](https://tc39.es/proposal-iterator-sequencing/).

## Example failing tests

- `test/built-ins/Iterator/concat/fresh-iterator-result.js`
- `test/built-ins/Iterator/concat/get-iterator-method-only-once.js`
- `test/built-ins/Iterator/zipKeyed/options.js`
- `test/built-ins/Iterator/prototype/flatMap/callable.js`
- `test/built-ins/Iterator/prototype/flatMap/flattens-iterable.js`

## Acceptance criteria

- `Iterator.prototype.flatMap` is callable; the `flatMap is not a function`
  bucket → 0 (≥ 25 of 31 flatMap tests pass).
- `Iterator.concat` and `Iterator.zip`/`zipKeyed` accept valid iterables (no more
  spurious "argument is not iterable"); ≥ 40 of the ~70 concat/zip tests pass.
- No regression in #1340's now-passing Iterator helper tests.

## Notes

`zip`/`zipKeyed` are a Stage proposal but **not** on the CLAUDE.md skip-filter
list (the deferred features are eval/with/Proxy/SAB/Temporal/WeakRef/FinReg/
dynamic-import/TLA). `flatMap` is shipped ES; prioritise it first. Feasibility
`hard` because the generator-backed helper lowering is involved (see #1340 lineage).

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).
