---
id: 3049
title: "Iterator.prototype helper methods (map/filter/take/drop/flatMap/…): 'X is not a function' + this-plain-iterator / return-forwarding residual (~27 fails)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: medium
created: 2026-07-05
task_type: bugfix
area: codegen, runtime
language_feature: iterator-helpers
goal: spec-completeness
test262_category: built-ins/Iterator/prototype
related: [3023]
---

# #3049 — Iterator.prototype helper methods residual

## Source

Fresh default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02). Of the ~158 fails under
`built-ins/Iterator/prototype/*`, **27** fail with a codegen/dispatch signature
(`object is not a function` / `undefined is not a function` /
`Cannot read properties of null`) rather than a pure assertion — i.e. the helper
method itself isn't wired, not just a semantic edge.

This is the **Iterator Helpers** surface (Stage-4: `map`/`filter`/`take`/`drop`/
`flatMap`/`reduce`/`some`/`find`/`every`/`forEach`/`toArray`). Distinct from
**#3023** (synthesized-iterator `.next` callability + for-of/for-await abrupt
completion) — this is the built-in `%Iterator.prototype%` helper methods.

## Root-cause hypothesis

The failing subset clusters on:
- **`this-plain-iterator`** twins across every helper — calling a helper with a
  plain (non-generator) iterator receiver resolves the helper (or its inner
  `next`) to a non-function.
- **`return-is-forwarded` / `exhaustion-does-not-call-return`** — the helper's
  wrapper iterator must forward/close the underlying iterator's `return`.
- **`flattens-iterable` / `iterable-to-iterator-fallback`** (flatMap) — GetIterator
  fallback on the flattened value.

Likely a single root: the helper wrapper's `GetIteratorDirect(O)` / `next`
resolution off a plain-object iterator receiver (vs a generator) yields
undefined/non-callable. Verify whether the helpers are registered at all on
`%Iterator.prototype%` for a non-generator receiver.

## Sample failing files (27 in the codegen subset; ~158 total incl. assertions)

- `built-ins/Iterator/prototype/map/this-plain-iterator.js` (+ filter/drop/find/every twins)
- `built-ins/Iterator/prototype/drop/return-is-forwarded.js`
- `built-ins/Iterator/prototype/filter/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/flatMap/flattens-iterable.js`, `iterable-to-iterator-fallback.js`
- `built-ins/Iterator/prototype/Symbol.iterator/return-val.js`

## Suggested approach

Start with one helper (`map`) + its `this-plain-iterator` case; trace how
`GetIteratorDirect` / the underlying `next` is resolved for a plain-object
iterator receiver and fix the resolution, then confirm the sibling helpers
inherit the fix. Coordinate with #3023 so the shared `.next`-callability path
isn't double-fixed.

## Acceptance criteria

- The 27 codegen-signature files (`this-plain-iterator`, `return-is-forwarded`,
  `flattens-*`) pass; helper `next`/`return` resolution works on a plain-object
  iterator.
- No regression in the generator-receiver helper paths or in #3023.
