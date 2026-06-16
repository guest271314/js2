---
id: 2162
title: "Standalone Map/Set/WeakMap/WeakSet conformance residual (~532 tests)"
status: in-progress
sprint: 62
created: 2026-06-15
updated: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: collections
goal: standalone-mode
parent: 1103
---

# Standalone Map/Set/Weak collections conformance residual

## Problem

Wasm-native Map/Set/WeakMap collections landed in #1103 (`done`, sprint 58).
The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows
**532 tests pass in host mode but fail standalone**, attributed to the
collection types — currently **untracked/unscheduled**.

## Evidence

- Gap categories: `built-ins/Set` 286, `built-ins/Map` 148,
  `built-ins/WeakMap` 101, plus WeakSet/WeakRef/FinalizationRegistry tails.
- `Set_new` and related host-import leaks plus `(none)`-leak compile errors.

## Acceptance criteria

- Standalone pass count for Map/Set/WeakMap/WeakSet rises toward host parity.
- No collection host-import leak (e.g. `Set_new`) for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1103. Part of sprint-62 standalone catch-up (rank 7 by gap
impact).

## Slice progress

- **Slice 1 — native Set runtime** (PR #1510): `new Set()`/add/has/delete/
  clear/size now host-import-free in standalone, reusing the #1103a Map backing
  store (Set = Map with value===key) via `src/codegen/set-runtime.ts`.
- **Slice 2 — native WeakMap/WeakSet runtime** (this PR): `new WeakMap()` /
  get/set/has/delete and `new WeakSet()` / add/has/delete now host-import-free
  in standalone (~101+ `built-ins/WeakMap` + WeakSet tests). New
  `src/codegen/weak-collections-runtime.ts` reuses the Map backing store with
  **object-identity keys** (the Map runtime already compares object keys by
  `ref.eq`) and adds only `__weakset_add(m,v)=__map_set(m,v,v)`; WeakMap
  get/set/has/delete and WeakSet has/delete route to `__map_*`. Wiring mirrors
  Map/Set: `new` → `__map_new` (new-super.ts); methods →
  `tryCompileNativeWeakMethodCall` (extern.ts); `WeakMap`/`WeakSet` resolve to
  `ref $Map` (index.ts); externClass registration skipped under `nativeStrings`.
  Weak collections have **no iteration and no `.size`** (spec), so none is
  wired. The *weak* (collectable) reference is not modelled — WasmGC has no weak
  refs, so entries are strongly retained; that is a memory property, not an
  observable one (only WeakRef/FinalizationRegistry liveness, skip-filtered,
  could tell). Host/gc mode unchanged.

  **Verified** (`tests/issue-2162-standalone-weak.test.ts`, 6/6, `--target wasi`,
  zero `WeakMap_*`/`WeakSet_*`/`Map_*` imports): WeakMap set+get / has / distinct
  keys / overwrite / delete; WeakSet add+has / delete / chained add.

### Triage note

Standalone **Map was already fully functional** — the apparent Map failures were
`m.get(k) === <literal>` boxed-compare confounds (the `any === literal` gap,
owned by value-rep #2104/#2106), not Map.

### Remaining slices (issue stays in-progress)

- Map/Set **iteration**: `forEach`, `for-of`, `keys`/`values`/`entries`,
  `new Map(iterable)` / `new Set(iterable)` — needs the `$MapIter` drive +
  `__map_new_from_arr`.
- ES2025 set-algebra: `union`/`intersection`/`difference`/… .
