---
id: 1836
title: "Standalone Number<->String conformance gaps (0o/0b, toFixed 1e21, exponential, fractional radix, whitespace, ToNumber) (residual #1335)"
status: in-progress
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
parent: 1335
---
# #1836 — standalone Number↔String conformance gaps

Residual of #1335 (marked done, sprint 58). All in the no-JS-host (standalone/WASI)
path; JS-host delegates to V8 and is correct.

## Defects
- `Number("0o17")`/`Number("0b101")` → `NaN` — only hex prefix handled
  (`src/codegen/parse-number-native.ts:949`). §7.1.4.1.
- `(1e21).toFixed(2)` emits a bogus 22-digit integer — no `≥1e21 → ToString` branch
  (`src/codegen/number-format-native.ts:894`). §21.1.3.3.
- `(1e-7).toString()`→`"0"`, `(1e21).toString()` lacks `e` — no exponential path
  (`number-format-native.ts:470`). §6.1.6.1.20.
- `(3.5).toString(2)` **traps** (`unreachable`) — fractional radix unimplemented (`:713`).
- `parseInt`/`parseFloat`/`Number` whitespace set misses U+FEFF, U+2028/2029, most Zs
  (`parse-number-native.ts:61`). §19.2.4/.5.
- `+"12abc"` → `12` instead of `NaN` — ToNumber(String) falls back to `parseFloat`
  (`src/codegen/type-coercion.ts:1748`).

## Fix
Add octal/binary prefix arms; add the 1e21 / exponential branches; emit fractional
radix digits; extend the whitespace predicate; emit a spec StringToNumber routine as
the standalone ToNumber fallback (not parseFloat).

## Progress (2026-06-04)

### Slice 1 — DONE: octal/binary prefix parsing (§7.1.4.1)
Fixed in `src/codegen/parse-number-native.ts` (`emitRadixPrefixParse`). Refactored
`buildArm` to be self-conditioned (reads `data[i+1]` and uses the prefix-letter
test as its own `if` condition) so three arms (`0x/0X`→16, `0o/0O`→8, `0b/0B`→2)
can be sequenced inside the shared `0`-prefix guard; a non-matching arm is a no-op
and falls through. Added `C_LC_B/C_UC_B/C_LC_O/C_UC_O` char-code constants.
- `Number("0o17")`/`"0O17"` → 15; `Number("0b101")`/`"0B101"` → 5
- `Number("0x1F")` → 31 unchanged; `Number("0o8")`/`"0b2"`/`"0o"` → NaN
- `Number("-0x1F")` etc. → NaN (NonDecimalIntegerLiteral is unsigned)
- `Number("08")` → 8 (leading-zero decimal, not legacy octal)
Tests: `tests/issue-1836.test.ts` (8 tests). No regression in
`tests/issue-1335-standalone.test.ts` (8) / `tests/issue-49-*` (7).

### Residual defects (not in this PR — track as follow-up slices)
- `(1e21).toFixed(2)` bogus 22-digit integer — `number-format-native.ts:894`. §21.1.3.3.
- `(1e-7).toString()`→`"0"`, `(1e21).toString()` lacks `e` — `number-format-native.ts:470`. §6.1.6.1.20.
- `(3.5).toString(2)` traps — fractional radix unimplemented (`:713`).
- whitespace set misses U+FEFF, U+2028/2029, most Zs — `parse-number-native.ts:61`. §19.2.4/.5.
- `+"12abc"` ToNumber(String) — VERIFIED already returns NaN on current main; appears fixed.

