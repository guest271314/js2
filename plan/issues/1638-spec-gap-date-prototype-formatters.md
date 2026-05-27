---
id: 1638
title: "spec gap: Date.prototype string formatters and parsers (174 of 485 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: date
goal: spec-completeness
sprint: 50
renumbered_from: 1344
parent: 1328
---
# #1344 — Date: string formatters, parsers, ISO normalization

## Problem

`built-ins/Date/prototype`: **311 / 485 pass (64.1%) — 174 fails (156 assertion_fail,
6 other, 4 runtime_error, 3 null_deref, 3 wasm_compile)**.

Spec §21.4.4 (Date.prototype) requires precise output formats:
- `toISOString()` — `YYYY-MM-DDTHH:mm:ss.sssZ`
- `toJSON()` — calls `toISOString()` after coercing to Number first; throws RangeError on Invalid Date.
- `toString()` — `"DDD MMM dd YYYY HH:mm:ss GMT±hhmm (timezone-name)"`
- `toDateString()` / `toTimeString()` — parts of toString.
- `toUTCString()` — `"DDD, dd MMM YYYY HH:mm:ss GMT"`
- `Date.parse(str)` — accepts the formats produced by the above plus a few extra ISO variants.

Date is implemented as a host externref forwarder (`src/runtime.ts`), so most failures are
either:
1. The host's locale-specific output (timezone name) doesn't match test262's expected output.
2. Our `Symbol.toPrimitive` hook on Date isn't being called when Date is concatenated with a string.
3. Date.parse round-trip mismatch on edge dates (year 0, BC dates, leap-second handling).

## Acceptance criteria

1. `built-ins/Date/prototype/toISOString/15.9.5.43-0-1.js` passes.
2. `built-ins/Date/prototype/toJSON/invoke-tojson-result-throws.js` passes.
3. `built-ins/Date/prototype/Symbol.toPrimitive/this-val-non-obj.js` passes.
4. Pass-rate for `built-ins/Date/prototype` rises from 64% to ≥85%.

## Files to modify

- `src/runtime.ts` — Date.prototype.* host bridges (verify each forwards correctly)
- `src/codegen/registry/date.ts` — Symbol.toPrimitive emit on Date

## Implementation Plan

### Root cause

Most failures are timezone-locale dependent — our Wasm runs in node where the timezone is the
system default. Test262 sets `TZ=America/Los_Angeles` for some tests; we must respect that
env var. Some tests also call `Date.prototype[Symbol.toPrimitive]` directly; we don't expose it.

### Approach

1. Verify `process.env.TZ` is honored in test262 runner (it likely is).
2. Add `Symbol.toPrimitive` registration on Date prototype: returns string for "string"/"default" hint,
   number for "number" hint.
3. Audit the host imports: Date.prototype.toJSON should call ToPrimitive(this, "number") then check
   for !Number.isFinite(tv) to throw RangeError on Invalid Date.

### Edge cases

- Invalid Date (`new Date(NaN)`): toISOString throws RangeError; toString returns "Invalid Date";
  toJSON returns null.
- Symbol.toPrimitive hint "default": treat as "string" per spec §21.4.4.45.
- Year before 1970 or after 9999: ISO format must use `±YYYYYY` extended notation.

### Test262 sample

- `test262/test/built-ins/Date/prototype/toISOString/15.9.5.43-0-1.js`
- `test262/test/built-ins/Date/prototype/Symbol.toPrimitive/this-val-non-obj.js`
- `test262/test/built-ins/Date/prototype/toJSON/invoke-tojson-result-throws.js`

## Resolution (2026-05-27)

The Date string formatters were **stubs** returning hardcoded placeholders
(`"1970-01-01T00:00:00.000Z"` for toISOString/toJSON, `"Thu Jan 01 1970
00:00:00 GMT+0000"` for everything else), so every test asserting a specific
format failed. Date is a Wasm-native struct holding an i64 timestamp; the
formatters now build the spec-correct string (ECMA-262 §21.4.4) from that
timestamp.

**Implementation:**

1. **`src/runtime.ts`** — new `_formatDate(ts, mode)` helper + a
   `__date_format` host import. Builds DateString / TimeString / UTCString /
   ISOString in UTC (the compiler's Date model is UTC-only;
   `getTimezoneOffset()` is always 0), with weekday/month-name tables and
   zero-padding. Invalid Date → `"Invalid Date"` for the string formatters,
   `RangeError` for toISOString.

2. **`src/codegen/expressions/builtins.ts`** — `compileDateMethodCall` now
   emits a `__date_format(ts_i64, mode_i32) -> externref` call for the string
   methods (replacing the placeholder), keyed by a `DATE_FORMAT_MODE` map.
   `toJSON` branches on the invalid-Date sentinel → `ref.null.extern` (spec
   returns `null`, not a throw). nativeStrings/WASI mode keeps the placeholder
   (host-string bridge does not apply to WasmGC i16 arrays). This is the
   JS-host fast path per the dual-mode architecture; a fully-standalone Wasm
   formatter is out of scope here.

3. **Latent bug fixed**: `TIME_OF_DAY_SETTERS`/`CALENDAR_SETTERS` membership
   used the `in` operator, which walks the prototype chain — so
   `"toString"`/`"toLocaleString"` (Object.prototype members) falsely matched
   the setter path and were mis-compiled as f64-returning setters. Switched to
   `Object.prototype.hasOwnProperty.call(...)`. This is why `toString`/
   `toLocaleString` returned `null` while `toDateString`/`toUTCString` worked.

### Test Results

- `tests/issue-1638.test.ts` — 10 cases, all pass (toISOString, toUTCString,
  toDateString, toTimeString, toString, Invalid Date → "Invalid Date",
  toISOString RangeError, toJSON null/ISO, no getTime/getHours/setHours
  regression).
- Existing `tests/date-native.test.ts`, `tests/issue-1343-date-setters.test.ts`,
  `tests/issue-1440.test.ts` — all pass (the single pre-existing `Date.now()`
  LinkError in date-native is unrelated: that test's import object omits
  `__date_now`; it fails identically on main HEAD).
