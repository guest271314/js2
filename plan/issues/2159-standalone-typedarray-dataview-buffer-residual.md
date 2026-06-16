---
id: 2159
title: "Standalone TypedArray/DataView/ArrayBuffer conformance residual (~1,308 tests)"
status: in-progress
sprint: 62
created: 2026-06-15
updated: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 1461
---

# Standalone TypedArray/DataView/buffer conformance residual

## Problem

TypedArray callback methods, generic array-like receivers, and DataView/
ArrayBuffer support landed in #1358, #1461, #1654 (all `done`, sprints
51–58). The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15)
shows **1,308 tests pass in host mode but fail standalone**, attributed to
TypedArray/DataView/buffer semantics — the third-largest catch-up bucket
and currently **untracked/unscheduled**.

## Evidence

- Gap categories: `built-ins/TypedArray` (565), `built-ins/TypedArrayConstructors`
  (321), `built-ins/DataView` (336), `built-ins/ArrayBuffer` (78),
  `built-ins/Atomics` (132).
- Mostly `(none)`-leak `compile_error` (525 TypedArray + 287 ctor +
  135 DataView) — standalone codegen gaps, not host-import shims.

## Acceptance criteria

- Standalone pass count for the TypedArray/DataView/ArrayBuffer/Atomics
  categories rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1461. Part of sprint-62 standalone catch-up (rank 3 by gap
impact). Compile-error-heavy — likely shares root cause with the #2079
late-import index-shift class for some constructors.

---

## Slice 1 (2026-06-16) — packed i8/i16 local leak on typed-array element writes

**Landed.** Triage of the standalone residual found the dominant
`(none)`-leak compile-error class: **every byte/short typed-array element
WRITE** (`a[i] = v` on `Uint8Array` / `Int8Array` / `Uint8ClampedArray` /
`Int16Array` / `Uint16Array`) was a hard compile error in standalone mode.

**Root cause** (`src/codegen/expressions/assignment.ts`
`compileElementAssignment`): the store-value temp local was allocated with the
array's RAW element type — `i8`/`i16`, which are *packed storage* types valid
only inside array elements / struct fields, never in a value position
(param/result/local/global). The binary emitter rejected the leaked local with
`encodeValType: packed storage type "i8" is not valid in a value position`. The
matching READ path already unpacks via `array.get_u`/`_s` → `i32`
(property-access.ts), so reads worked but writes did not — making the entire
byte/short typed-array surface unusable standalone.

**Fix:** unpack the store-value local type `i8`/`i16` → `i32`; `array.set`
re-packs the `i32` into the element. One disjoint type fix, no behavioral change
for `Int32Array`/`Float64Array` (their element type is already a value type).

Verified standalone: set/get, negative in-range values, loop writes, compound
assignment (read-modify-write), and 8-bit store wrap (256 → 0) all pass.
Test: `tests/issue-2159.test.ts`.

### Remaining slices (issue stays open)

- **ArrayBuffer.byteLength** reads 0 standalone (`new ArrayBuffer(8).byteLength`
  → 0, expect 8).
- **DataView** leaks `env::` host imports standalone (`new DataView(buf)` and
  `getInt32`/`setInt32`/`getFloat64`/… are not standalone-native) — the 336-test
  DataView bucket.
- Int8Array signed-read of an out-of-range store (`a[0]=200` → expect -56)
  reads unsigned — a separate signed/wrap concern, not the leak above.
