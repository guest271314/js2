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

## Triage (2026-06-16)

Probed each collection in standalone (`target: standalone`). Findings:

- **Map is already fully functional** in standalone — `new/set/get/has/
  delete/size/clear` all return correct values when the result is read into a
  typed binding. The apparent Map failures in casual probing were
  `m.get(k) === <literal>` confounds (the `any === literal` boxed-compare gap,
  not Map). No Map work needed for the core methods.
- **Set had NO native standalone runtime** — `new Set()` / `add` / `has` /
  `size` leaked `Set_new` / `Set_add` / `Set_has` / `Set_get_size` host imports
  the standalone module can't satisfy, so every Set program failed. This is the
  dominant slice of the gap (`built-ins/Set` ≈ 286).

## Slice 1 — native Set runtime (PR #1510, merged)

A Set is a Map with `value === key`, so the entire #1103a Map backing store
(`map-runtime.ts`: ordered hash table, SameValueZero key equality, tombstone
deletion) is reused. New module `src/codegen/set-runtime.ts` adds only
`__set_add(m, v) = __map_set(m, v, v)` and the dispatch interceptors; `has` /
`delete` / `clear` / `size` route straight to the `__map_*` helpers.

Wiring (mirrors Map): `new Set()` → `__map_new` (new-super.ts); method calls →
`tryCompileNativeSetMethodCall` (extern.ts); `.size` →
`tryCompileNativeSetSizeGet` (property-access.ts); `Set` resolves to `ref $Map`
(resolveWasmType, index.ts); and the `Set` externClass registration is skipped
under `nativeStrings` so no `Set_*` host import is emitted. Host/gc mode is
unchanged (still uses the externClass path).

**Verified** (`tests/issue-2162-standalone-set.test.ts`, 6/6, `--target wasi`,
zero `Set_*`/`Map_*` imports): add+has, size dedup, delete + return value,
clear, string-element dedup, chained `add().add()`.

## Slice 2 — native WeakMap/WeakSet runtime (PR #1524)

WeakMap is a Map and WeakSet is a Set with `key === value`, both over
object-identity keys (the Map runtime already compares object keys by `ref.eq`).
New `src/codegen/weak-collections-runtime.ts` reuses the Map backing store and
adds only `__weakset_add`; get/set/has/delete route to `__map_*`. No iteration,
no `.size` (spec). Strong retention (WasmGC has no weak refs) is a memory
property, not observable.

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

### Remaining slices (follow-up; issue stays in-progress)

- **Set.forEach** — the `isSet` parameter of `tryCompileNativeCollectionForEach`
  is ready; wire it into `set-runtime.ts`'s dispatch (now on main).
- `keys()`/`values()`/`entries()` + `for-of` over Map/Set — exposing a
  JS-iterable iterator object that the for-of drive consumes.
- `new Map(iterable)` / `new Set(iterable)` constructors.
- ES2025 set-algebra: `union`/`intersection`/`difference`/
  `symmetricDifference`/`isSubsetOf`/`isSupersetOf`/`isDisjointFrom`.
- The `Set === literal` / Set-of-`any` comparison confounds depend on the
  value-rep work (#2104/#2106), out of scope here.
