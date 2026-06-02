---
id: 1735
title: "Number.prototype.toExponential(NaN) collides with no-arg sentinel — returns variable digits instead of ToInteger(NaN)=0"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: medium
feasibility: easy
task_type: bugfix
area: codegen
language_feature: number-formatting
goal: test262-conformance
sprint: Backlog
test262_fail: 1
test262_category: built-ins/Number/prototype/toExponential
related: [49, 1321, 1731]
---
# #1735 — toExponential(NaN) wrongly treated as no-arg (sentinel collision)

## Problem

`(123.456).toExponential(NaN)` returns `"1.23456e+2"` (variable digits) instead
of the spec-correct `"1e+2"` (0 fraction digits).

Per ECMA-262 [§21.1.3.3](https://tc39.es/ecma262/#sec-number.prototype.toexponential)
step 5, `f = ToIntegerOrInfinity(fractionDigits)`, and
[ToIntegerOrInfinity(NaN)](https://tc39.es/ecma262/#sec-tointegerorinfinity) is
**+0** (§7.1.5). So an explicit `NaN` argument must format with 0 fraction
digits, identical to `toExponential(0)`.

## Root cause

The `number_toExponential` / `number_toPrecision` runtime helpers in
`src/runtime.ts` overload `NaN` as a **"no argument supplied" sentinel** — the
codegen no-arg branch in `src/codegen/expressions/calls.ts` pushes
`f64.const NaN` and the helper does `isNaN(d) ? v.toExponential() : v.toExponential(d)`
(#1321). When the user passes an *explicit* `NaN` (or a computed `0/0`), it
carries the same bits as the sentinel, so it is wrongly handled as no-arg
(variable digits) rather than ToInteger(NaN)=0 (one digit).

## Fix

Normalise the digits/precision f64 local **NaN → 0** in the arg-present branch
(both `toExponential` and `toPrecision`), before the range check + call, via a
self-compare `select` (`d == d` is false only for NaN). This reserves the NaN
sentinel strictly for the zero-argument codegen branch, with no host-side
change. Added a `normalizeNaNToZero(fctx, f64Local)` helper next to
`coerceNumberMethodArgToF64` in `src/codegen/expressions/calls.ts`.

For `toPrecision`, NaN→0 then trips the existing RangeError gate (0 ∉ [1,100]),
matching V8: `(1.5).toPrecision(NaN)` throws RangeError (already asserted by the
#49 regression guard, which continues to pass).

## Acceptance criteria

- `(123.456).toExponential(NaN)` → `"1e+2"`, `(0).toExponential(NaN)` → `"0e+0"`.
- Genuine no-arg `(123.456).toExponential()` → `"1.23456e+2"` (unchanged).
- `(1.5).toPrecision(NaN)` still throws RangeError (#49 guard intact).
- test262 `Number/prototype/toExponential/tointeger-fractiondigits.js` improves.

## Source

Filed by dev-a from a value-semantics test262 triage pass 2026-05-29.
Implemented + tested in `tests/issue-1735.test.ts` (6 cases) alongside the #49
regression guard (7 cases) — all 13 pass.
