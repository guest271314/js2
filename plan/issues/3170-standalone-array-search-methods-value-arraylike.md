---
id: 3170
title: "standalone: Array.prototype.indexOf/lastIndexOf/includes — method-as-value + array-like receivers (125 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 2670, 3169, 2861, 2175]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
---

# #3170 — standalone: Array.prototype search methods as values + over array-likes

## Problem

**125 host-pass tests are not host-free-standalone passes** under
`built-ins/Array/prototype/{indexOf,lastIndexOf,includes}` (indexOf 63,
lastIndexOf 54, includes 8; measured 2026-07-12 lane-baseline diff, method in
#3169). Two measured signatures:

1. `TypeError: Array.prototype.lastIndexOf is not yet callable as a value in
   standalone mode` — the prototype-method **value read** (S6-b refusal
   lineage, #1907/#1888): `var f = Array.prototype.indexOf; f.call(obj, 7)`.
   Across ALL of `Array.prototype` this signature accounts for 76 gap rows,
   most of them in this family.
2. `fail: returned 2 — assert #1 … Array.prototype.indexOf.call(obj, …)` —
   array-like receivers with `fromIndex` coercion (`ToIntegerOrInfinity`),
   negative-index clamping, sparse holes, and `length` read via `ToLength`.

## ANTI-BLOAT directive

- Signature 1 is exactly what the **native-proto glue** exists for:
  `src/codegen/native-proto.ts` / `native-proto-value-read.ts`
  (`getNativeProtoBuiltinGlue`, the #2861 pattern) mint callable closures for
  prototype members. Add these three members to the EXISTING glue member CSV +
  memberKind tables — do NOT invent a new value-read path. #2175's
  native-method-closure dispatch spec is the architectural reference.
- Signature 2 rides the SAME generic `$Object`-receiver arm #3169 builds in
  `src/codegen/closed-method-dispatch.ts`. If #3169 lands first, this issue is
  mostly the value-read + `fromIndex`/SameValueZero edge semantics; sequence
  after or alongside #3169 with that boundary agreed (receiver ladder = #3169,
  value-read + search-specific coercion = #3170).

## Acceptance criteria

- ≥90 of the 125 measured gap tests flip to host-free standalone passes.
- Sample tests:
  - `test/built-ins/Array/prototype/indexOf/15.4.4.14-1-6.js`
  - `test/built-ins/Array/prototype/lastIndexOf/15.4.4.15-5-21.js`
  - a `…is not yet callable as a value` repro:
    `var f = Array.prototype.indexOf;` used via `.call` must run host-free.
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, one method family — no drive-by fixes to other Array methods.
