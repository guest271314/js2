---
id: 1787
title: "Regression coverage for packed TypedArray integer semantics"
status: done
created: 2026-06-03
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: test
area: testing
language_feature: typedarray
goal: correctness
sprint: 59
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

## Resolution (2026-06-04, dev-w1)

Landed `tests/issue-1787-packed-typedarray-semantics.test.ts` (9 cases) using
the issue's "mark unsupported as pending" approach.

**Live guards (pass today):**
- `Uint8Array([255])[0] === 255` — both `gc` and `standalone`.
- `Uint16Array([65535])[0] === 65535` (value-correct on the current f64 lane).
- Under `--target standalone`, `Uint8Array` reads use `array.get_u` and never
  `array.get_s` — the exact packed-unsigned WasmGC invariant the native byte
  fix depends on.

**Forward-looking `it.fails` sentinels (correctly red today; flip to hard
guards when #1799 lands the packed signed/16-bit/clamped storage; JS-host
boundary nuances are #1786):**
- `Int8Array([255])[0] === -1` — Int8Array still lowers to `$Vec[f64]`
  (returns 255 today, no packed-signed read).
- `Int16Array([65535])[0] === -1` (packed signed 16-bit).
- `Uint8ClampedArray` write coercion: negative → 0, >255 → 255, and
  round-half-to-even (2.5 → 2, 3.5 → 4) — no clamping is applied today.

Caveat surfaced during probing: in `gc` mode `Uint8Array` does **not** use
`array.get_u` (native byte storage auto-enables only for WASI/standalone), so
the `array.get_u` WAT assertion is standalone-scoped — documented in the test.
