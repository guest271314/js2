---
id: 1799
title: "Generalize TypedArray storage to packed WasmGC lanes"
status: ready
created: 2026-06-03
updated: 2026-06-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: typedarray
goal: performance
sprint: Backlog
related: [389, 608, 1199, 1767, 1800, 1786, 1787]
---
# #1799 - Generalize TypedArray storage to packed WasmGC lanes

## Problem

The native/WASI `Uint8Array` path now uses packed `i8` storage with unsigned
loads, fixing the worst 64 MiB native-messaging memory amplification. The rest
of the TypedArray family still mostly uses the legacy `f64` vec representation,
which is both memory-heavy and semantically blurry.

Typed arrays have fixed-width element semantics. Their WasmGC backing arrays
should reflect those widths instead of routing all numeric typed arrays through
double storage.

## Desired Representation

- `Int8Array` -> packed `i8`, read with `array.get_s`.
- `Uint8Array` -> packed `i8`, read with `array.get_u`.
- `Uint8ClampedArray` -> packed `i8`, read with `array.get_u`, clamp writes.
- `Int16Array` -> packed `i16`, read with `array.get_s`.
- `Uint16Array` -> packed `i16`, read with `array.get_u`.
- `Int32Array` -> `i32`.
- `Uint32Array` -> `i32` with unsigned boundary semantics where observable.
- `Float32Array` -> `f32`.
- `Float64Array` -> `f64`.

## Acceptance

- Add constructor, indexed read/write, `.set`, `.subarray`, and stdout/stdin
  regression coverage for packed integer typed arrays under standalone/WASI.
- `Uint8Array([255])[0] === 255`.
- `Int8Array([255])[0] === -1`.
- `Uint16Array([65535])[0] === 65535`.
- `Int16Array([65535])[0] === -1`.
- Existing native-messaging tests remain below the current memory cap.
- JS-host mode behavior does not regress; if full JS-host support is not in
  scope, gate the packed representation to no-host targets and document it.

## Notes

This should build on the scoped native `Uint8Array` packed-storage fix rather
than reintroducing f64 conversion arrays. The broader design should probably
land after #1800 introduces explicit typed-array element metadata.
