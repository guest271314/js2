---
id: 2164
title: "Standalone Date conformance residual (~234 tests)"
status: in-progress
sprint: 63
created: 2026-06-15
updated: 2026-06-17
assignee: ttraenkler/dev-date
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: date
goal: standalone-mode
parent: 1343
---

# Standalone Date conformance residual

## Problem

Date prototype formatters landed in #1343 (`done`, sprint 50). The
host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows **234
tests pass in host mode but fail standalone**, attributed to Date semantics
— currently **untracked**.

## Evidence

- Gap category: `built-ins/Date` 235; `(none)`-leak compile errors (219)
  dominate — standalone codegen gaps in Date construction/formatting/coercion.

## Acceptance criteria

- Standalone pass count for `built-ins/Date` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1343. Part of sprint-62 standalone catch-up (rank 10 by gap
impact).

---

## Slice 1 (2026-06-16) — `Date.now()` / `new Date()` no-arg host-import leak

**Landed.** Triage showed most Date functionality already works standalone
(explicit-timestamp ctor, getTime, UTC components, setters, toISOString,
multi-arg ctor, NaN, Date.UTC). The dominant *foundational* failure: `Date.now()`
and `new Date()` (no args) emitted the `env::__date_now` host import
**unconditionally** in non-WASI mode — under `--target standalone` (no JS host,
no WASI clock) that import is unsatisfiable, so every module calling `Date.now()`
or `new Date()` (commonly in test setup) failed to instantiate, taking unrelated
Date assertions down with it.

**Fix** (`expressions/calls.ts` Date.now/performance.now; `expressions/new-super.ts`
`new Date()`): pure standalone has no wall-clock source, so emit the Unix epoch
(`f64.const 0` / `i64.const 0`) directly — deterministic, no import leak, module
instantiates. WASI still uses its clock; host mode unchanged (gated on
`ctx.standalone === true`). Test: `tests/issue-2164.test.ts` — Date.now()/new
Date()/performance.now() instantiate, mixed setup+explicit-timestamp works,
explicit dates unaffected (5/5). Host date-basic equiv unchanged (12/12).

## Slice 2 (2026-06-17) — standalone `toISOString()` / `toJSON()` pure-Wasm formatter

**Landed.** The Date string formatters delegate to the `__date_format(ts, mode)`
host import. In standalone / nativeStrings mode there is no JS host, so the
`ctx.nativeStrings` branch (`expressions/builtins.ts`) emitted a hard-coded
placeholder `"1970-01-01T00:00:00.000Z"` for `toISOString`/`toJSON` — every
non-epoch call returned the wrong string. Instance getters/setters
(`getUTC*`, `setUTC*`, `getTime`, `valueOf`) were already correct standalone;
the formatters were the gap.

**Fix:** new pure-Wasm helper `__date_iso_string(ts: i64) -> ref $NativeString`
(`ensureDateIsoStringHelper`, builtins.ts) builds the ECMA-262 §21.4.4.36 Date
Time String Format directly from the millisecond timestamp:
- floor-divides `ts` into `days` + `msOfDay`, reuses `__date_civil_from_days`
  for the calendar fields, and fills a 27-element i16 array via a write cursor;
- handles the §21.4.1.18 extended ±YYYYYY year form for years <0 or >9999
  (4-digit `YYYY` otherwise);
- returns a `$NativeString(len, off=0, data)`.
The `toISOString`/`toJSON` nativeStrings branch now calls it. Per spec,
`toISOString` throws **RangeError** "Invalid time value" on an Invalid Date
(new `emitThrowRangeError` helper, helpers.ts) and `toJSON` returns **null**.
Host mode (`__date_format` path) is untouched.

Test: `tests/issue-2164-iso.test.ts` (13/13) — exact-string conformance vs host
JS for epoch, arbitrary, sub-second ms, mid-day h/m/s/ms, extended +6-digit
year, the 9999↔10000 4-digit/extended boundary; plus toJSON-null, toISOString
RangeError-on-invalid, pre-epoch (1969), ms round-trip. Existing `issue-1638`
(host formatters) + `issue-1343-negative-year` suites unchanged.

### Remaining slices (issue stays open)

- **`Date.parse(str)`** returns 0 standalone — date-string parser not wired
  standalone (PR #1633 slice). Medium.
- **Negative-year calendar getters** (`getUTCFullYear()` etc.) are wrong for
  pre-year-0 timestamps standalone (`__date_civil_from_days` negative-`days`
  gap, pre-existing) — so `toISOString` of a negative *year* is also off. The
  formatter itself is correct given a correct year; this is upstream of Slice 2.
- Real current-time semantics standalone are intentionally NOT provided (no
  clock source); only the instantiate-blocking leak is fixed (Slice 1).
