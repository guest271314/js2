---
id: 1828
title: "Array-like find/findIndex skip holes; map compacts holes (sparse .call receivers)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1828 — array-like find/findIndex/map hole handling

## Symptom
With an array-like `.call` receiver `{length:3, 0:1, 2:3}` (index 1 a hole):
- `Array.prototype.findIndex.call(o, x=>x===undefined)` → `-1` (spec `1`).
- `Array.prototype.map.call(o, x=>x*2).length` → `2` (spec `3`, holes preserved).

## Location
`src/codegen/array-methods.ts:824-895` wraps find/findIndex bodies in `gatedBody`
(HasProperty) — but spec visits holes as `undefined`. `:937-987` map builds the
result via `__js_array_push`, compacting holes and shifting indices.

## Spec
ECMAScript §23.1.3.9/.10 (find/findIndex visit every index), §23.1.3.20 (map
preserves length / holes). Dense arrays are unaffected.

## Fix
Drop `gatedBody` for find/findIndex; write mapped values by index into a length-`len`
result (leave holes) instead of push.

