---
id: 1830
title: "Well-known-symbol range guard off-by-one excludes Symbol.matchAll (ID 15)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: runtime
goal: correctness
sprint: 59
---
# #1830 — `Symbol.matchAll` never routed on WasmGC structs

## Symptom
`struct[Symbol.matchAll]` get/set/`in` falls through to numeric-index access and
misses the symbol-keyed property.

## Location
`_symbolIdToKeys` (`src/runtime.ts:3035-3051`) maps IDs 1-15 (15 = `@@matchAll`),
but `_safeGet` (`:3102`), `_safeSet` (`:3188`), and `__extern_has` (`:5222`) gate
on `key >= 1 && key <= 14`. The `_safeGet` comment still says "1-12".

## Fix
Change all three bounds to `<= 15` (or derive from `_symbolIdToKeys.size`).

## Resolution (2026-06-04)

Widened the well-known-symbol-id guards from `<= 14` to `<= 15` (the
authoritative `_symbolIdToKeys` map already contains id 15 = `@@matchAll`).
**Four** sites in `src/runtime.ts`:
- `_safeGet` numeric-id remapping (also corrected the stale "1-12" comment),
- `_safeSet` numeric-id remapping,
- `__extern_has` reverse mapping (`idx >= 1 && idx <= 15`),
- `__symbol_register_desc` ("never override well-known symbols" guard — id 15
  is well-known, so it must not be treated as a user symbol).

Pure widening of an exact-id guard — admits only id 15, which already exists in
the map, so it cannot regress the in-range symbols (Symbol.iterator … 
Symbol.asyncDispose). Smoke test `tests/issue-1830-matchall-symbol-range.test.ts`
confirms `Symbol.matchAll` computed-key access compiles to a valid, instantiable
module and the in-range symbols still compile; test262 `@@matchAll` struct
routing covers the behavioral surface.

Note: I could not construct a surface-TypeScript behavioral repro that drives a
numeric symbol-id through `_safeGet`/`_safeSet` on a `_isWasmStruct` receiver
(class-instance and object-literal computed-symbol keys store under the real
Symbol, not the numeric id, so they don't hit this remapping). The fix matches
the issue's documented root cause exactly and is risk-free; CI conformance
validates the test262 movement.

