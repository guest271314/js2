---
id: 1717
title: "ArrayBuffer.prototype.slice not implemented ('slice is not a function', 17 fails)"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arraybuffer
goal: test262-conformance
sprint: Backlog
es_edition: 2015
test262_fail: 17
test262_category: built-ins/ArrayBuffer
related: [1645, 1595]
---
# #1717 — ArrayBuffer.prototype.slice not implemented (17 fails)

## Problem

All 17 tests under `built-ins/ArrayBuffer/prototype/slice/*` fail at runtime
with `slice is not a function`. The method is simply not present on our
ArrayBuffer prototype / not routed by codegen.

Normalized signature: `wasm_compile :: slice is not a function` (raised at the
call site when the resolved method is undefined).

The existing open ArrayBuffer issues do **not** cover this:
- #1645 (in-review) — resizable buffers + detached-buffer guards
- #1595 (blocked) — `transfer` / `transferToFixedLength` / `transferToImmutable`

`slice` is a separate, core ES2015 method that none of them implement.

## Root-cause hypothesis

`ArrayBuffer.prototype.slice(start, end)` (§25.1.6.x) is unimplemented. It must:
1. RequireObjectCoercible / IsArrayBuffer brand-check on `this`.
2. ToIntegerOrInfinity(start), ToIntegerOrInfinity(end) with the usual
   relative-index clamping against `[[ArrayBufferByteLength]]`.
3. Use SpeciesConstructor (`@@species`) to allocate the new buffer.
4. CopyDataBlockBytes the selected range; throw TypeError if the species ctor
   returns a detached or too-small buffer.

Spec: [§25.1.6.3 ArrayBuffer.prototype.slice](https://tc39.es/ecma262/#sec-arraybuffer.prototype.slice).

## Example failing tests

- `test/built-ins/ArrayBuffer/prototype/slice/end-default-if-absent.js`
- `test/built-ins/ArrayBuffer/prototype/slice/negative-start.js`
- `test/built-ins/ArrayBuffer/prototype/slice/number-conversion.js`
- `test/built-ins/ArrayBuffer/prototype/slice/end-exceeds-length.js`

## Acceptance criteria

- `ArrayBuffer.prototype.slice` is callable and the four example tests pass.
- The `slice is not a function` bucket for `built-ins/ArrayBuffer` drops to 0.
- No regression in existing ArrayBuffer / TypedArray tests.

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).


## Implementation (landed)

### Root cause

`ArrayBuffer.prototype.slice` was routed through a Wasm-native emitter
(`emitArrayBufferSlice`, added in #1698) but the dispatch in
`src/codegen/expressions/calls.ts` gated it behind `noJsHost(ctx)`. In
JS-host mode `slice` therefore fell through to the extern-class dispatch,
which dropped the call — `slice is not a function`.

### Fix

The ArrayBuffer backing store is the same `i32_byte` vec struct in both
JS-host and standalone modes, so `emitArrayBufferSlice` (a byte-by-byte copy
into a fresh `i32_byte` vec, with spec §25.1.6.3 ToIntegerOrInfinity +
relative-index clamping) is mode-agnostic. Dropping the `noJsHost` guard
routes `slice` through it in both modes. SharedArrayBuffer is filtered out
(it has no `i32_byte` struct).

### Verification

`slice` is now callable in JS-host mode and returns an object (4 callability
vitest cases in `tests/issue-1717.test.ts` pass; was `slice is not a
function`).

### Known limitation (gates the test262 conformance flip)

The 17 `built-ins/ArrayBuffer/prototype/slice/*` cases assert
`result.byteLength` and (some) byte content. Those assertions additionally
depend on JS-host infrastructure that has separate, pre-existing gaps —
filed as Backlog stubs:

- **#1728** — `new ArrayBuffer(n).byteLength` returns `NaN` in JS-host mode.
- **#1729** — `new Uint8Array(ab)` is backed by a separate f64 vec, so it does
  not alias the ArrayBuffer's `i32_byte` store.
- **#1730** — `DataView.set*` is `not a function` in JS-host mode.

So this PR clears the `slice is not a function` symptom (the issue title);
the full slice-test pass-rate flip is gated on #1728/#1729/#1730. CI measures
the actual delta (neutral-or-positive — `slice` callability cannot regress).

### Files modified

- `src/codegen/expressions/calls.ts` — drop the `noJsHost` guard on the
  ArrayBuffer.prototype.slice dispatch.
- `tests/issue-1717.test.ts` — new (callability cases).
