---
id: 2503b
title: "standalone any-vs-typed-string == mis-coerces string operand to NaN (operand-order asymmetry)"
status: done
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, type-coercion
language_feature: loose-equality, string-coercion, abstract-operations
goal: standalone-mode
sprint: 61
related: [1910, 1910d, 1472, 2073, 2081, 1134]
assignee: ttraenkler/sdev-looseeq
---
## Problem

In `src/codegen/binary-ops.ts`, equality where one operand is `any`/object and
the other is a **statically string-typed** operand was handled
**asymmetrically** by operand order:

- `"ab" == a` (a: any) → routed through `compileStringBinaryOp` (correct
  §7.2.15 string-aware comparison) via the existing left-string arm → **true**.
- `a == "ab"` (a: any) → fell through to the equality / standalone `noJsHost`
  dispatch, which **ToNumber-coerced the string literal** to
  `__box_number(__str_to_number("ab"))` = NaN. So equal strings compared
  unequal: `function eq(a: any) { return a == "ab"; } eq("ab")` returned
  **false** standalone (while `a === "ab"` and the reversed `"ab" == a` both
  returned true).

Found by sdev-looseeq while implementing #1910d (the loose-eq Object↔primitive
ToPrimitive arm): the object→String reduction cases (`new String("x") == "x"`,
`{toString}` vs a string literal) bottomed out on this defect even though the
ToPrimitive arm correctly produced the reduced string — it then compared the
reduced string against a string-typed literal in `a == "lit"` order and got the
NaN mis-coercion. Reproduces with **zero objects involved**.

## Root cause

The coercion plan had a left-string equality arm (string `==` non-numeric →
`compileStringBinaryOp`) but **no symmetric right-string equality arm** — the
right-string arm was gated to `+` (`PlusToken`) only. So a string-typed RIGHT
operand against a non-numeric LEFT (`any`/object) skipped the string dispatch
and fell into the numeric coercion path.

## Fix

Add the mirror of the left-string equality arm: when the op is an equality op
(`==`/`!=`/`===`/`!==`), the **right** operand is string-typed, and the **left**
operand is not a number/boolean/bigint/string, route through
`compileStringBinaryOp` (the same dispatch the reversed order already used).
This restores operand-order independence. Left-string pairs are excluded
(already handled by the arm above); number/boolean/bigint lefts keep their
numeric §7.2.15 coercion.

JS-host mode is unaffected (those comparisons route through
`__host_loose_eq`/`__host_eq` = correct JS `==`/`===`); the rerouting only
changes the standalone path that previously mis-coerced.

## Acceptance

- `a == "ab"` (a: any, a==="ab") → `true` standalone; `a != "ab"` → `false`;
  mismatch (`a` is `"xy"`) → `false`; strict `a === "ab"` → `true`; reversed
  `"ab" == a` unchanged → `true`.
- JS-host mode compiles & validates (no codegen regression).
- 0 regressions across #1776 / #1134 / #1986 / native-string equality suites.
- Test: `tests/issue-2503b-any-string-loose-eq.test.ts` (standalone runtime +
  JS-host compile/validate).
