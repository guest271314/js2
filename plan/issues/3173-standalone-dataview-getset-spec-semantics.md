---
id: 3173
title: "standalone: DataView.prototype get*/set* spec semantics — brand, index coercion order, bounds RangeError, detached-buffer ordering (230 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: dataview
goal: standalone
umbrella: 2860
sprint: current
horizon: l
related: [2860, 3062, 3054, 3058, 2872]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
---

# #3173 — standalone: DataView.prototype get\*/set\* spec semantics

## Problem

**230 host-pass tests are not host-free-standalone passes** under
`built-ins/DataView/prototype/` — ALL of them hard `fail` rows, no leaky
passes (measured 2026-07-12 lane-baseline diff, method in #3169). Spread
across every getter/setter (setBigInt64 18, setFloat16 18, getFloat16 16,
getInt32 14, getBigUint64/getBigInt64 13 each, …, byteLength 8, byteOffset 7,
buffer 7).

Measured signatures:

- `RangeError: Offset is outside the bounds of the DataView` thrown at the
  WRONG time (15 rows) — spec order is: brand check → `ToIndex(requestIndex)`
  → `ToNumber/ToBigInt(value)` (setters) → detached check → bounds check.
  We evaluate bounds before/instead of the coercions, so
  `detached-buffer-before-outofrange-byteoffset.js`-style ordering tests fail.
- `assert.throws(TypeError, …)` not throwing (dozens of rows) — missing
  [[DataView]] brand check (`this-has-no-dataview-internal.js`), missing
  detached-buffer TypeError.
- `assert.throws(RangeError, …)` not throwing — `index-is-out-of-range.js`,
  negative/`Infinity`/`-0` `ToIndex` edge cases.
- Float16 rows additionally need the f16 codec round-trip.
- Accessors `buffer`/`byteLength`/`byteOffset` invoked-as-accessor / wrong
  receiver (#3062 fixed the value; the brand/accessor protocol remains).

## ANTI-BLOAT directive

- The native lowering EXISTS: `src/codegen/dataview-native.ts`. This issue
  re-orders and completes its per-method prologue — do NOT fork a second
  DataView path, and do NOT touch the WASI linear-memory rewrite (#3012, a
  different axis).
- Factor the prologue ONCE: a single shared
  `brand → ToIndex → [ToNumber/ToBigInt] → detached → bounds` sequence
  parameterized by element kind, reused by all 20+ get*/set* methods. The
  per-element byte codec already exists (#3057's runtime-kind codec on
  `$__ta_dyn_view`) — reuse its kind tables rather than re-encoding widths.
- BigInt methods coerce via `ToBigInt` (TypeError on Number), Float16 via the
  existing f16 helpers used by `Math.f16round`/TypedArray f16 if present.

## Acceptance criteria

- ≥170 of the 230 measured gap tests under `built-ins/DataView/prototype/`
  flip to host-free standalone passes.
- Sample tests:
  - `test/built-ins/DataView/prototype/setUint32/this-has-no-dataview-internal.js`
  - `test/built-ins/DataView/prototype/setInt16/index-is-out-of-range.js`
  - `test/built-ins/DataView/prototype/getFloat64/detached-buffer-before-outofrange-byteoffset.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR. SharedArrayBuffer-backed rows stay out of scope (skip-listed).
