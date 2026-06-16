---
id: 1826
title: "OrdinaryToPrimitive treats valueOf/toString returning undefined as method-absent"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: runtime
goal: correctness
sprint: 59
---
# #1826 — `valueOf` returning `undefined` is treated as "absent"

## Symptom
`({valueOf(){return undefined}, toString(){return "x"}}) + ""` → `"x"` instead of
`"undefined"` — a method legitimately returning the primitive `undefined` is
skipped and the next method is consulted.

## Location
`src/runtime.ts`: `tryMethod` (inside `_toPrimitive`) returned JS `undefined`
both for "absent / returned an object / dispatch trapped" and a real `undefined`
primitive; the caller treated `undefined` as "try the next method."

## Spec
ECMAScript §7.1.1.1 OrdinaryToPrimitive steps 5-6 (any non-Object return is the result).

## Fix
Introduced a module-private `_PRIM_ABSENT` unique-symbol sentinel. `tryMethod`
now returns `_PRIM_ABSENT` for the absent / returned-object / dispatch-trapped
cases, and the produced primitive (including a real `undefined`) otherwise. The
valueOf/toString selection in `_toPrimitive` checks `!== _PRIM_ABSENT` so a
method that returns the primitive `undefined` is honored rather than skipped.

## Notes / residual depth (out of scope here)
The cited `tryMethod` distinction is fixed. Fully observing it end-to-end on the
common surface syntaxes is gated on two adjacent concerns that are **not** part
of this issue:
- The 13 `_toPrimitive` callers branch on `prim !== undefined` (not the
  sentinel), so the function's external contract still collapses to `undefined`
  for not-found. A follow-up could thread `_PRIM_ABSENT` through those callers
  (higher risk: a leaked symbol into `String()` throws), but that exceeds this
  issue's scope.
- A WasmGC closure returning `undefined` marshals to host `null` at the
  Wasm↔host boundary, so `String(o)` on a struct whose method returns
  `undefined` currently yields `"null"` — a separate marshaling concern.
- Many `+ ""` / `String()` forms are statically folded in codegen (no runtime
  ToPrimitive call) by the #1470 any→string work, so they bypass this path.

## Test Results
Existing ToPrimitive regression suites pass unchanged with the sentinel:
`tests/issue-1253`, `tests/issue-1319`, `tests/issue-1716`, `tests/issue-1090`,
`tests/issue-850`, `tests/issue-866`, `tests/issue-983-opaque`, `tests/issue-1434`,
`tests/issue-1732-math-symbol-coercion`. `tests/issue-1128` test #2 was a stale
expectation documenting a since-fixed (#1470) limitation; updated to the
spec-correct `"hello world"`.
