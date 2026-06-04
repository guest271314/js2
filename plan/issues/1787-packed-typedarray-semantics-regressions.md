---
id: 1787
title: "Regression coverage for packed TypedArray integer semantics"
status: ready
created: 2026-06-03
updated: 2026-06-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: test
area: testing
language_feature: typedarray
goal: correctness
sprint: Backlog
related: [608, 1767, 1799, 1800, 1786]
---
# #1787 - Regression coverage for packed TypedArray integer semantics

## Problem

The native `Uint8Array` memory fix relies on a subtle WasmGC invariant:
packed `i8` is the storage lane, while unsignedness is selected by using
`array.get_u` on reads. Future changes can easily regress this by emitting
plain `array.get` for packed arrays, by using signed loads for unsigned arrays,
or by accidentally inserting f64 conversion arrays.

## Acceptance

- Add tests covering unsigned and signed packed-byte reads:
  - `Uint8Array([255])[0] === 255`
  - `Int8Array([255])[0] === -1`
- Add tests covering 16-bit signedness:
  - `Uint16Array([65535])[0] === 65535`
  - `Int16Array([65535])[0] === -1`
- Add `Uint8ClampedArray` write/coercion coverage:
  - negative values clamp to `0`
  - values above `255` clamp to `255`
  - fractional values follow JS clamping rules
- Add a validation test that packed typed-array WAT uses `array.get_u` or
  `array.get_s` as appropriate and does not emit invalid `array.get` against
  packed array types.
- Cover both no-host targets and the JS-host boundary, or explicitly split
  uncovered JS-host behavior into #1786.

## Notes

This issue is test-first guardrail work. It can be implemented before the full
storage generalization in #1799 by marking unsupported constructors as pending
or by landing focused tests alongside each representation change.
