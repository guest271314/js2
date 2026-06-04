---
id: 1836
title: "Standalone Number<->String conformance gaps (0o/0b, toFixed 1e21, exponential, fractional radix, whitespace, ToNumber) (residual #1335)"
status: ready
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

