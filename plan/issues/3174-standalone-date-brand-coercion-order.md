---
id: 3174
title: "standalone: Date receiver brand checks + ToPrimitive coercion order (get*/set*/toISOString/Symbol.toPrimitive — 107 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: date
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 2671, 2891, 3171]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff; slices the Date area of tracking issue #2671"
---

# #3174 — standalone: Date brand checks + coercion order

## Problem

**107 host-pass tests are not host-free-standalone passes** under
`built-ins/Date/` (83 of them under `Date/prototype/`; measured 2026-07-12
lane-baseline diff, method in #3169). This slices the Date area that tracking
issue #2671 explicitly asks to be sliced, restricted to the standalone lane.

Measured signatures:

- The BULK (52 rows: `returned 3 — assert #2 … assert.throws(TypeError,
  function() { g*/s*…`) are the S15.9.5.x `A6_T*` **brand-check** tests:
  every `Date.prototype.get*/set*/to*` must throw `TypeError` when applied to
  a non-Date receiver (`Date.prototype.getTime.call({})`,
  `.call(Date.prototype)` — note `Date.prototype` itself is NOT a Date in
  ES6+). Assert #1 passes (the happy path works); assert #2 (the throw)
  doesn't.
- **ToPrimitive / coercion order** (~10 rows): `coercion-order.js`,
  `value-symbol-to-prim-return-obj.js`, `value-to-primitive-call-err.js` —
  `new Date(value)` must run the full §21.4.2.2 ToPrimitive protocol
  (Symbol.toPrimitive lookup errors propagate, object-returning exotic
  toPrimitive falls through correctly). #2891 built the
  valueOf→toString fallthrough for nominal structs — extend, don't duplicate.
- `setTime`-family argument `ToNumber` side-effect ordering; `Date.parse`
  edge rows (2); `Date.prototype[Symbol.toISOString/toPrimitive]` surface
  rows.

## ANTI-BLOAT directive

- The native Date kernel EXISTS (`src/codegen/date-parse-native.ts` + the
  Date arms in the closed-method dispatcher). Add ONE shared
  [[DateValue]]-brand preamble applied to every Date prototype-method arm in
  `closed-method-dispatch.ts` — the same shared-gate shape as the collections
  brand gate (#3171); if #3171 lands its generic brand-preamble helper first,
  REUSE it with the Date brand.
- Coercion-order rows extend the EXISTING `__to_primitive` /
  `coercion-engine.ts` protocol (#2862/#2891 lineage) — no Date-local
  ToPrimitive copy.

## Acceptance criteria

- ≥80 of the 107 measured gap tests under `built-ins/Date/` flip to host-free
  standalone passes.
- Sample tests:
  - `test/built-ins/Date/prototype/toISOString/15.9.5.43-0-11.js`
  - `test/built-ins/Date/S15.9.3.1_A6_T5.js` (brand throws)
  - `test/built-ins/Date/coercion-order.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR. Locale/timezone-dependent formatting rows are out of scope if they
  need host TZ data — note them in the PR instead of shimming.
