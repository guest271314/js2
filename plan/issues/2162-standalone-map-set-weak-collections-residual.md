---
id: 2162
title: "Standalone Map/Set/WeakMap/WeakSet conformance residual (~532 tests)"
status: in-progress
sprint: 63
created: 2026-06-15
updated: 2026-06-17
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
  owned by value-rep #2104/#2106, not Map). No Map work needed for the core
  methods.
- **Set had NO native standalone runtime** — leaked `Set_new`/`Set_add`/… host
  imports, so every Set program failed (`built-ins/Set` ≈ 286, the dominant
  slice). Same for WeakMap/WeakSet (101+).

## Slice 1 — native Set runtime (PR #1510, merged)

A Set is a Map with `value === key`, so the entire #1103a Map backing store
(ordered hash table, SameValueZero key equality, tombstone deletion) is reused.
New `src/codegen/set-runtime.ts` adds only `__set_add(m, v) = __map_set(m, v, v)`
and the dispatch interceptors; `has`/`delete`/`clear`/`size` route to `__map_*`.
Wiring mirrors Map: `new Set()` → `__map_new` (new-super.ts); methods →
`tryCompileNativeSetMethodCall` (extern.ts); `.size` →
`tryCompileNativeSetSizeGet` (property-access.ts); `Set` resolves to `ref $Map`
(index.ts); externClass skipped under `nativeStrings`. Host/gc unchanged.
**Verified** `tests/issue-2162-standalone-set.test.ts` 6/6.

## Slice 2 — native WeakMap/WeakSet runtime (this PR)

`new WeakMap()` / get/set/has/delete and `new WeakSet()` / add/has/delete now
host-import-free in standalone (~101+ tests). New
`src/codegen/weak-collections-runtime.ts` reuses the Map backing store with
**object-identity keys** (the Map runtime already compares object keys by
`ref.eq`) and adds only `__weakset_add(m,v)=__map_set(m,v,v)`; the rest route to
`__map_*`. Wiring mirrors Map/Set: `new` → `__map_new` (new-super.ts); methods →
`tryCompileNativeWeakMethodCall` (extern.ts); `WeakMap`/`WeakSet` resolve to
`ref $Map` (index.ts); externClass skipped under `nativeStrings`. Weak
collections have **no iteration and no `.size`** (spec), so none is wired. The
*weak* (collectable) reference is not modelled — WasmGC has no weak refs, so
entries are strongly retained; a memory property, not observable (only WeakRef/
FinalizationRegistry liveness, skip-filtered, could tell). Host/gc unchanged.
**Verified** (`tests/issue-2162-standalone-weak.test.ts`, 6/6, `--target wasi`,
zero `WeakMap_*`/`WeakSet_*`/`Map_*` imports): WeakMap set+get / has / distinct
keys / overwrite / delete; WeakSet add+has / delete / chained add.

## Slice 3 — native Set.forEach (PR, dev-1, 2026-06-17)

`Set.prototype.forEach` produced **invalid Wasm** standalone (the call fell
through `tryCompileNativeSetMethodCall`'s `add/has/delete/clear` gate to the
generic host path). Fixed by routing `forEach` to the shared
`tryCompileNativeCollectionForEach(..., isSet=true)` — the SAME entries-vector
drive Map.forEach (#1527) already uses, which already had the `isSet` branch
(passes the value as both `value` and `key` per spec 24.2.3.6). One import + a
3-line dispatch route in `set-runtime.ts`; no new runtime helper. Verified
standalone (empty-`{}` instantiate, zero `Set_*`/`Map_*` imports): count, sum,
value===key, tombstone-skip after delete, insertion order, empty-set no-op.
Test: `tests/issue-2162-set-foreach.test.ts` (6/6).

## Slice 4 — `new Set([...])` / `new Map([[k,v],...])` from array literal (PR, dev-1, 2026-06-17)

The constructor-from-iterable forms fell through to the host path:
`new Set([1,2,3])` leaked `env.*` imports, `new Map([[1,10]])` was a hard
"Unsupported new expression". Fixed in `new-super.ts` for the **array-literal**
argument (the dominant iterable form): build the empty `$Map` (`__map_new`),
then seed element-by-element — each Set element via `__set_add` (dedups through
the shared insert), each Map `[k,v]` pair via `__map_set`. Keys/values boxed via
`coerceMapKeyToAnyref`; the no-arg forms are unchanged. A non-array-literal
iterable (spread, a variable, a non-pair Map element) still falls back to the
empty collection (the general iterator drive is the remaining slice below).
Verified standalone (empty-`{}` instantiate, zero `Set_*`/`Map_*` imports): seed
+ size, dedup, has(), empty literal, seeded-forEach, Map pair overwrite, no-arg
control. Test: `tests/issue-2162-collection-from-array.test.ts` (10/10).

### Remaining slices (issue stays in-progress)

- `keys()`/`values()`/`entries()` + `for-of` over Map/Set — needs a JS-iterable
  iterator object. (Confirmed still broken standalone 2026-06-17:
  `for (const v of set)` yields 0.) The general `new Map(iterable)` /
  `new Set(iterable)` over a NON-literal iterable also needs this drive (Slice 4
  covers only array literals).
- ES2025 set-algebra: `union`/`intersection`/`difference`/
  `symmetricDifference`/`isSubsetOf`/`isSupersetOf`/`isDisjointFrom`.
- The `Set === literal` / collection-of-`any` comparison confounds depend on the
  value-rep work (#2104/#2106), out of scope here.

## Slice — ES2025 Set set-algebra (PR, dev-1, 2026-06-17)

All 7 ES2025 Set set-algebra methods are now Wasm-native standalone/WASI (they
leaked `Set_*` host imports before). New `src/codegen/set-algebra.ts`:
`union`/`intersection`/`difference`/`symmetricDifference` return a new Set;
`isSubsetOf`/`isSupersetOf`/`isDisjointFrom` return a boolean. Each builds on the
shared `$Map` backing store — walk one operand's entries vector (the same
insertion-ordered, tombstone-skipping walk `forEach`/`__map_iter_next` use) and
consult the other via `__map_has`, accumulating into a fresh Set (`__map_new` +
`__set_add`) or an i32 flag. Dispatched from `extern.ts` when BOTH the receiver
and the single argument type as `Set` (a genuine Set `b`; a Set-LIKE arg / the
GetSetRecord path is a follow-up). No host import, no iterator object.

Verified standalone (empty-`{}`/wasi, zero `Set_*`/`Map_*` imports): all 7 ops,
true+false predicate cases, content checks, dedup. Test:
`tests/issue-2162-set-algebra.test.ts` (10/10, operands built via `.add()` so the
slice is independent of the `new Set([...])` constructor slice). tsc + prettier
clean; Set Slice-1 unaffected.
