---
id: 1645
title: "spec gap: ArrayBuffer resizable + TypedArray detached-buffer guards (100 + 39 test262 fails)"
status: blocked
created: 2026-05-08
updated: 2026-05-27
priority: medium
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: typedarray
goal: spec-completeness
sprint: 50
renumbered_from: 1351
parent: 1328
---
# #1351 — ArrayBuffer.resize / detached-buffer guards on TypedArray methods

## Problem

`built-ins/ArrayBuffer`: **87 / 196 pass (44.4%) — 100 fails (44 wasm_compile, 36 assertion_fail,
9 other, 5 null_deref, 1 type_error)**.
`built-ins/DataView`: **410 / 561 pass (73.1%) — 26 runtime_error among 112 fails**.
`built-ins/Uint8Array`: **31 / 68 pass (45.6%) — 37 fails**.

Spec §25.1 (ArrayBuffer): ArrayBuffer can be resizable (constructor accepts `{maxByteLength}`) or
fixed-length. Detached buffers throw TypeError on every read/write/access.

Spec §23.2 (TypedArray): every prototype method must check IsDetachedBuffer at the start, throw
TypeError if detached. ArrayBuffer.transfer detaches the source.

The 44 wasm_compile errors in ArrayBuffer suggest the ResizableArrayBuffer constructor signature
isn't recognized — the typed-codegen path gets a wrong arity.

## Acceptance criteria

1. `built-ins/ArrayBuffer/prototype/resize/length.js` passes.
2. `built-ins/ArrayBuffer/transfer/detaches-source-buffer.js` passes.
3. `built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js` passes.
4. `built-ins/DataView/prototype/getInt32/detached-buffer-throws.js` passes.
5. Pass-rate for `built-ins/ArrayBuffer` rises from 44% to ≥75%.

## Files to modify

- `src/runtime.ts` — `__arraybuffer_*` host imports
- `src/codegen/registry/typedarray.ts` — detached-buffer guards on every prototype method

## Implementation Plan

### Root cause

ResizableArrayBuffer is newer (ES2024); our codegen registry doesn't have an overload for the
options-object constructor `new ArrayBuffer(byteLength, {maxByteLength})`. Type-inference picks
the wrong overload and emits a wasm_compile-failing call.

Detached-buffer guards: each TypedArray method needs a prologue:
```
if (IsDetachedBuffer(this[[ViewedArrayBuffer]])) throw TypeError
```
We've inlined the methods without this guard.

### Approach

1. **Resizable**: add an options-object constructor variant. Store `maxByteLength` in the
   ArrayBuffer struct; `.resize(newLength)` updates `byteLength` if `<= maxByteLength`, throws
   RangeError otherwise.
2. **transfer**: implement by allocating a new buffer, copying data, marking source detached.
3. **Detached guards**: extend the codegen registry so every TypedArray method emits a detached
   check at entry. Add `IsDetachedBuffer` host import that returns 1/0.

### Edge cases

- `transfer()` with no argument → use source's byteLength.
- `transfer(newLen)` where newLen > source: zero-pad.
- Detached check must run even for length-0 access (e.g. `view.getInt8(0)` on a 0-length detached buffer).
- DataView: detached check separate from ArrayBuffer detached.

### Test262 sample

- `test262/test/built-ins/ArrayBuffer/prototype/resize/length.js`
- `test262/test/built-ins/ArrayBuffer/transfer/detaches-source-buffer.js`
- `test262/test/built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js`

## Investigation 2026-05-27 (developer) — ESCALATED-NEEDS-SPEC

Reproduced gaps against current main (HEAD b290fe96d). The issue's stated scope
("add resize() stub + detached guard in runtime.ts") and `feasibility: medium`
**underestimate the work** — the core blocker is the ArrayBuffer representation.

### What's actually missing (verified by reading source + probes)
- `new ArrayBuffer(n, {maxByteLength})` — options object ignored; no resizable state.
- `ArrayBuffer.prototype.resize` — **not a function** (entirely missing).
- `ArrayBuffer.prototype.maxByteLength` / `.resizable` getters — missing.
- `ArrayBuffer.prototype.transfer` / `.transferToFixedLength` — **not a function**
  as callable methods (the #1515 detach plumbing exists, but no `transfer()` entry point).
- `ArrayBuffer.prototype.slice` — **not a function**.
- TypedArray prototype methods (copyWithin/set/subarray/fill/…) lack an
  IsDetachedBuffer prologue. DataView's get/set path *does* guard
  (`src/runtime.ts:4609`), but TypedArray methods do not.

### Root-cause blocker (the architect decision)
ArrayBuffer / DataView are compiled to a **fixed-length `i32_byte` WasmGC vec
struct** (`src/codegen/dataview-native.ts:22`, `getOrRegisterVecType(ctx,
"i32_byte", …)`). The runtime reads/writes bytes via the exported
`__dv_byte_{len,get,set}` accessors (`src/codegen/index.ts:2823-2825`), but a
WasmGC array is **fixed-length once allocated** — the runtime cannot grow it.

Therefore `resize(newLen)` to a *larger* size is **structurally impossible**
under the current representation. It requires one of:
1. **Over-allocate to `maxByteLength`** at construction; track the logical
   `byteLength` separately (sidecar or a struct field) and clamp reads/writes to
   it. `resize` then just updates the logical length. Simple, but wastes memory
   for large `maxByteLength`.
2. **Indirection struct**: `{ data: (mut ref i32_byte_vec), len: (mut i32),
   maxLen: i32, detached: (mut i32) }` so `resize` can swap in a freshly
   allocated, copied backing array. Cleaner semantics; touches the buffer
   struct shape, every `__dv_byte_*` accessor, and the DataView/TypedArray
   view-window metadata (`_dvViewMeta`, `__dv_register_view`).

Either path is a **representation change spanning codegen + runtime**, not a
runtime stub. The issue's named file `src/codegen/registry/typedarray.ts`
**does not exist** (stale reference) — TypedArray/DataView method dispatch lives
in the host-import fallback at `src/runtime.ts:4591` (`dvMatch`) plus
`src/codegen/dataview-native.ts`.

### Recommendation (split)
- **Architect spec needed** for resizable ArrayBuffer (`resize`, `maxByteLength`,
  `resizable`, `transfer`, `transferToFixedLength`) — pick representation option
  1 vs 2 above. This is the bulk of the 100 ArrayBuffer fails (incl. the 44
  `wasm_compile` from the unrecognized 2-arg ctor).
- **Separable follow-up (developer-scoped, no representation change)**: add the
  IsDetachedBuffer prologue to TypedArray prototype methods, mirroring the
  DataView guard at `runtime.ts:4609` (the `_detachedBuffers` WeakSet +
  `__is_detached_buffer` infra already exists). This covers the ~39 Uint8Array
  + part of the DataView detached fails independently. Worth a dedicated
  sub-issue once the dispatch site for TypedArray methods is confirmed against
  the real test262 runner (the standalone harness used here does not wire
  `$DETACHBUFFER`, so detached-path behaviour must be validated in CI / the
  vitest equivalence harness, not ad-hoc).

Status set to `blocked` / `feasibility: hard` pending the representation spec.
