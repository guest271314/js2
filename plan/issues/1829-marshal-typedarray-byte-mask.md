---
id: 1829
title: "marshalTypedArrayArgs byte-masks every element, corrupting non-Uint8Array typed arrays"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: low
task_type: bugfix
area: runtime
goal: correctness
sprint: 59
---
# #1829 — typed-array argument marshaling truncates to bytes

## Symptom
Passing an `Int16Array`/`Int32Array`/`Float32Array`/`Float64Array` to a compiled
export silently corrupts every element (truncated to its low byte), producing
wrong results, not an error.

## Location
`src/runtime.ts:9855-9876`: the loop accepts both `kind==="uint8array"` and
`kind==="typed-array"`, then writes `vecSetByte(vec, j, src[j]! & 0xff)` (`:9874`).
The `& 0xff` is only correct for `Uint8Array`. The vec backing store is f64, so
full precision would otherwise round-trip.

## Fix
Apply `& 0xff` only when `kind==="uint8array"`; for `"typed-array"` write `src[j]`
unmasked via the vec setter.

