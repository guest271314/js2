---
id: 3173
title: "standalone: DataView.prototype get*/set* spec semantics — brand, index coercion order, bounds RangeError, detached-buffer ordering (230 gap tests)"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-dataview
created: 2026-07-12
updated: 2026-07-13
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: dataview
goal: standalone
umbrella: 2860
sprint: 71
horizon: l
related: [2860, 3062, 3054, 3058, 2872]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
# (#3102/#3131) Intentional growth for this slice: the spec-semantics core
# (throw templates, f16/i64 codecs, __dv_m_* helper, reflective bodies) lives
# in the SUBSYSTEM module dataview-native.ts per the anti-bloat directive; the
# other files carry only the dispatch/wiring arms (dispatcher brand arm,
# reflective-call route, ctor wrap gate, detach-write hook, getter fixes).
loc-budget-allow:
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/any-helpers.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/array-object-proto.ts
  - src/emit/binary.ts
# (#2108) The 5 new __is_truthy references are the §7.1.2 ToBoolean(littleEndian)
# spec step routed through the SHARED native truthiness helper (the engine's own
# vocabulary — no fresh coercion matrix): the direct-path le flag, the minted
# __dv_m_* helper, and their pre-registrations.
coercion-sites-allow:
  - src/codegen/dataview-native.ts
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

## Test Results (2026-07-12, implementation PR)

**217 of the 230 measured gap tests flip to host-free standalone passes**
(threshold ≥170). `built-ins/DataView/prototype/` standalone: 458/499
(baseline ≈240). All three sample tests pass. Tests: `tests/issue-3173.test.ts`
(12 cases, zero-import standalone modules). Host lane: local
`equivalence-gate` clean (36 failing = the 36 known-baseline entries, no new
regressions); `check:ir-fallbacks` OK.

What landed (all `noJsHost`-gated unless noted):

- `$__dv_window` IS the standalone [[DataView]] brand — `new DataView(buf)`
  always wraps (runtime-gated on the `i32_byte` vec; `$__resizable_ab`
  subtype passes); bare-vec receivers throw the brand TypeError.
- Shared spec-order core `brand → ToIndex → [ToNumber] → ToBoolean(le) →
  detached → bounds → op`, factored once (emitter subroutines + the minted
  `__dv_m_<member>` helper) and reused by the direct call path, the
  closed-method dispatcher's new `$__dv_window` arm (any-receivers inside
  `assert.throws` callbacks), and the reflective `DataView.prototype.<m>`
  member-closure bodies (`.call` brand tests, incl. lib-missing `getFloat16`
  via syntactic init resolution).
- `$DETACHBUFFER` marker write intercepted standalone (buffer vec
  `length = −1`); detached TypeError correctly ordered; `byteLength`/
  `byteOffset` getters throw on detached; `.buffer` returns the ACTUAL shared
  buffer (identity).
- Float16 codec (`__f16_decode`/`__f16_encode`, single-rounding RN-even) and
  BigInt64/BigUint64 i64 codec (bigint-branded carrier — exact 64-bit
  roundtrip); unary `-`/`~` now PRESERVE the bigint i64 brand (host-lane
  effect: `-1n` boxes as a real bigint, strictly more correct).
- test262-runner fix (both lanes' scoring): paren-balance guard on the
  `assert_sameValue_bool` rewrite — `assert.sameValue(get*(0, false), X)`
  was being corrupted into a bool-compare for EVERY DataView le-literal row.

Residual 13 (out of slice scope):

- 4 SAB rows (skip-listed per acceptance).
- 7 `set-values-return-undefined` rows — blocked on the pre-existing
  standalone any-array **boxed/string index read** defect (`anyArr[i]` with a
  HOF-callback index param reads wrong): SAME underlying bug family as
  **#3179** (its for-in string-key face; repro here:
  `[0].forEach((v, i) => anyArr[i])` reads undefined). Deliberately not
  duplicated — #3179 owns it; a fix there flips these 7 plus JSON rows.
- `Symbol.toStringTag`, `byteLength/resizable-array-buffer-auto` (auto-length
  tracking), `buffer/invoked-as-accessor` (descriptor-getter extraction).

Known pre-existing gap documented while testing: the helper-route `===`
(`__any_from_extern` + `__any_strict_eq`) has no bigint tag (JsTag lacks
BigInt), so mixed-module bigint compares can misroute — the inline `===`
cascade and the patched `__extern_strict_eq` handle it; full fix belongs to
the #1644 bigint-rep track.
