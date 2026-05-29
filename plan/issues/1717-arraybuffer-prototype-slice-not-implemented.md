---
id: 1717
title: "ArrayBuffer.prototype.slice not implemented ('slice is not a function', 17 fails)"
status: ready
created: 2026-05-29
updated: 2026-05-29
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
