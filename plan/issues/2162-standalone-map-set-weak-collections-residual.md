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

## Slice 3 — native Map.forEach iteration (this PR)

The #1103a Map runtime served get/set/has/delete/clear/size but **not**
iteration, so `m.forEach(cb)` leaked a `Map_forEach` host import in standalone
(and silently no-op'd). This drives the callback over the `$Map` entries vector
directly — the same insertion-ordered, tombstone-skipping walk
`__map_iter_next` uses — invoking `cb(value, key, map)` per live entry
(§24.1.3.5). `tryCompileNativeCollectionForEach` in `map-runtime.ts` resolves
the callback to a Wasm closure (`compileArrowAsClosure`), externalizes each
`anyref` value/key to `externref` and coerces to the callback's param types,
and `call_ref`s the closure (result dropped). Wired into
`tryCompileNativeMapMethodCall`'s `forEach` arm.

**Verified** (`tests/issue-2162-map-foreach.test.ts`, 6/6, `--target wasi`, zero
`Map_*` imports): sum values, value+key, insertion order, tombstone-skip after
delete, empty map, string keys.

The `isSet` parameter of the driver is ready for **Set.forEach**, which lands
once the native Set runtime (PR #1510) merges (its dispatch is in
`set-runtime.ts`). `keys()`/`values()`/`entries()` + `for-of` (exposing a
JS-iterable iterator object) and `new Map/Set(iterable)` remain follow-up
slices.
