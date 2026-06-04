---
id: 1786
title: "wrapExports ABI support for packed TypedArray vectors"
status: ready
created: 2026-06-03
updated: 2026-06-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime, host-interop
language_feature: typedarray
goal: platform
sprint: Backlog
related: [1700, 1737, 1767, 1799, 1800]
---
# #1786 - `wrapExports` ABI support for packed TypedArray vectors

## Problem

JS-host `wrapExports` currently assumes the TypedArray export boundary can
allocate and populate f64-element vecs through helpers such as
`__new_vec_f64` plus `__vec_set_byte`. That matches the old `Uint8Array`
representation, but not packed native storage such as `i8_byte`.

The scoped 64 MiB native-messaging fix keeps packed `Uint8Array` limited to
no-host targets, so JS-host exports are not broken. A general packed TypedArray
implementation needs an ABI story for JS callers and JS-visible returns.

## Acceptance

- `wrapExports` can marshal JS `Uint8Array` arguments into the correct packed
  WasmGC vec when a compiled export accepts `Uint8Array`.
- `wrapExports` can marshal packed `Uint8Array` return values back to JS
  `Uint8Array` without first expanding to f64/plain arrays.
- Add analogous support or explicit documented deferral for `Int8Array`,
  `Uint8ClampedArray`, `Int16Array`, and `Uint16Array`.
- Existing #1700 `Uint8Array` export-param tests keep passing.
- Modules without TypedArray export signatures do not emit unnecessary
  allocator/mutator helper exports.

## Notes

This may need typed-array metadata from #1800 so runtime marshalling knows
which allocator and write semantics to use.
