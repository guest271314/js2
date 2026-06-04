---
id: 1829
title: "marshalTypedArrayArgs byte-masks every element, corrupting non-Uint8Array typed arrays"
status: done
completed: 2026-06-04
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

## Resolution (2026-06-04)

`src/runtime.ts` `marshalTypedArrayArgs`: gated the `& 0xff` on
`kind === "uint8array"`; the `"typed-array"` catch-all now writes `src[j]`
unmasked. `__vec_set_byte` widens its i32 value arg via `f64.convert_i32_u`
into the f64 vec backing store, so unsigned-integer typed arrays
(`Uint16Array` / `Uint32Array`) now round-trip up to 2^32-1 at full precision
instead of being truncated to bytes.

Test: `tests/issue-1829.test.ts` (4, all pass) compiles `Uint16Array` /
`Uint32Array` exports, calls them via `wrapExports({ marshal: false })`, and
reads the marshalled vec back with `__vec_get`/`__vec_len` to assert the real
element values cross the boundary; a guard confirms `Uint8Array` still
byte-masks (unchanged #1700 semantics). `tsc`/`biome`/`prettier` clean.

### Known residual (separate follow-up)
The wire setter `__vec_set_byte` is `(externref, i32, i32) -> ()` and converts
the value with `f64.convert_i32_u` (**unsigned**). So:
- `Int16Array` / `Int32Array` **negative** elements still become large
  positives (e.g. -1 → 4294967295), and
- `Float32Array` / `Float64Array` **fractional** elements are truncated to
  integers.
Full fidelity for signed/float typed arrays needs a dedicated full-precision
vec setter (`__vec_set_f64(externref, i32, f64)`) emitted in codegen — a larger
change than this localized runtime fix. This PR strictly improves on the prior
"truncate every element to a byte" behaviour for the common unsigned-integer
case; signed/float fidelity is left for a codegen follow-up.

