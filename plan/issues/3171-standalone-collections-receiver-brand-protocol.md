---
id: 3171
title: "standalone: Map/Set/WeakMap/WeakSet receiver brand-check protocol — spec TypeError on incompatible receivers (~142 direct gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: 2015
language_feature: collections
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 3172, 2893, 2916]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
---

# #3171 — standalone: collections receiver brand-check protocol

## Problem

The four keyed collections contribute **375 gap tests** (Set 141, Map 104,
WeakMap+WeakSet 130; measured 2026-07-12 lane-baseline diff, method in #3169).
After carving out the ES2025 additions (#3172, 120 tests), the dominant
remaining signature — **~142 direct tests plus a share of the ~113-test
residual** — is the **[[MapData]]/[[SetData]]/[[WeakMapData]]/[[WeakSetData]]
brand check**:

```js
// built-ins/Set/prototype/entries/does-not-have-setdata-internal-slot-set-prototype.js
assert.throws(TypeError, function () {
  Set.prototype.entries.call(Set.prototype);   // and .call({}), .call([]), .call(new Map()) …
});
```

Measured signatures: `TypeError: Method Set.prototype.* called on incompatible
receiver` thrown with the WRONG shape/at the wrong time (16 rows), and
`fail: returned 2 — assert #1 … assert.throws(TypeError, …)` where no
TypeError is thrown at all (the bulk). Same story for
`this-not-object-throw-null/undefined/number/…` across all four collections.

## ANTI-BLOAT directive

- The native collection runtimes EXIST: `src/codegen/map-runtime.ts`,
  `set-runtime.ts`, `weak-collections-runtime.ts`. This issue is a
  **cross-cutting brand gate**, not new methods: every prototype-method entry
  point must first do the spec §24.x step-1/2 check (receiver is an Object AND
  has the right internal-slot brand) and throw the spec `TypeError` otherwise.
- Do it ONCE: add a shared brand-check preamble helper (pattern: the
  `$__ta_dyn_view` view-brand check from #2893, and `shape-brand.ts`) that all
  four runtimes' dispatch arms in `closed-method-dispatch.ts` call — not four
  hand-rolled copies. Wrong-brand-but-collection receivers
  (`Map.prototype.get.call(new Set())`) must also throw.
- Accessor `size` (Set 5 / Map 7 rows) goes through the same gate on its
  getter.

## Acceptance criteria

- ≥120 of the measured brand/receiver gap tests
  (`does-not-have-*-internal-slot-*`, `this-not-object-throw-*` under
  `built-ins/{Map,Set,WeakMap,WeakSet}/prototype/`) flip to host-free
  standalone passes.
- Sample tests:
  - `test/built-ins/Set/prototype/entries/does-not-have-setdata-internal-slot-set-prototype.js`
  - `test/built-ins/Map/prototype/size/does-not-have-mapdata-internal-slot-set.js`
  - `test/built-ins/WeakSet/prototype/delete/this-not-object-throw-null.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- Out of scope: `class MySet extends Set` subclassing CEs (8 rows — separate
  root cause, builtin-super construction lineage #2917), and #3172's methods.
