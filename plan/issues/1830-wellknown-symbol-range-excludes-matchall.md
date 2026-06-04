---
id: 1830
title: "Well-known-symbol range guard off-by-one excludes Symbol.matchAll (ID 15)"
status: ready
created: 2026-06-04
updated: 2026-06-04
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

