---
id: 3171
title: "standalone: Map/Set/WeakMap/WeakSet receiver brand-check protocol — spec TypeError on incompatible receivers (~142 direct gap tests)"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-collections-brand
created: 2026-07-12
updated: 2026-07-13
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: 2015
language_feature: collections
goal: standalone
umbrella: 2860
sprint: 71
horizon: m
related: [2860, 3172, 2893, 2916]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
# (#3102) God-file growth allowance for THIS change-set: the bulk of #3171
# lives in NEW subsystem modules (receiver-brand.ts, collections-brand.ts);
# the residual growth below is unavoidable wiring — the size-getter glue in
# the glue factory's home module (+77), the COLLECTION_KIND field + reflective
# receiver params in the collection runtime itself (+48), the kind operand at
# the 3 ctor sites (+6), and the reflective-gate swap comment (+2).
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/map-runtime.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/calls.ts
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
  four runtimes' dispatch arms call — not four hand-rolled copies.
  Wrong-brand-but-collection receivers (`Map.prototype.get.call(new Set())`)
  must also throw.
  - **Pointer correction (impl finding):** the dispatch arms are NOT in
    `closed-method-dispatch.ts` (that module handles closed object-literal
    struct methods). The real brand machinery is `emitSetBrandCheck`
    (set-runtime.ts, #2604), the three `tryCompileNative*MethodCall`
    direct dispatchers wired via `expressions/extern.ts`, and the reflective
    `.call` interception in `expressions/calls.ts`.
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

## Test Results (2026-07-12, implementation)

Measured on the standalone lane (`TEST262_TARGET=standalone`,
filter `built-ins/{Map,Set,WeakMap,WeakSet}/prototype`) vs the
`test262-standalone-current.jsonl` main baseline:

- **158 flips fail→pass, 0 regressions** (suite: 320→478 of 700).
  150 are brand/receiver-protocol rows (`does-not-have-*`,
  `this-not-object-*`, `context-is-*`); 8 bonus rows (size descriptor
  meta `name`/`length`/`size.js`, `Map.set` return-map rows). Acceptance
  bar was ≥120 ✓.
- Host (gc) lane on the same filter: 0 flips, 0 regressions — byte-inert as
  intended (all paths `nativeStrings`/standalone-gated).
- `tests/issue-3171.test.ts`: 48 equivalence tests. Regression suites green:
  #2604 (31), #2607 set-algebra (27), #2377/#2861 proto-value-read,
  collection batch (116; 3 pre-existing failures reproduced on clean tree).

### What landed (for #3172/#3174 reuse)

- `src/codegen/receiver-brand.ts` — **the shared brand preamble**:
  `emitReceiverBrandCheck(ctx, fctx, recvType, spec)` with
  `spec: { message, structTypeIdx, kindField?: { fieldIdx, accept[] } }`.
  Consumes the compiled receiver, leaves non-null `(ref structTypeIdx)`,
  throws catchable TypeError on a miss. #3172: pass the Set spec from
  `collectionBrandSpec(ctx, "Set")` (collections-brand.ts). #3174: pass
  Date's struct typeIdx with no `kindField`.
- `src/codegen/collections-brand.ts` — reflective `.call` dispatch, all four
  collections; `collectionBrandSpec` exported.
- `COLLECTION_KIND` tag field on `$Map` (map-runtime.ts, `MAP_LAYOUT.M_KIND`),
  stamped by `__map_new(kind)`.
- `size` accessor getter glue for Map/Set (array-object-proto.ts,
  `makeCollectionGlue` → `emitCollectionSizeGetterBody`).
