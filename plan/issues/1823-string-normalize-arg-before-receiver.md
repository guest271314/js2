---
id: 1823
title: "String#normalize(form) evaluates argument before receiver (wrong eval order)"
status: done
completed: 2026-06-04
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1823 — `String#normalize(form)` evaluates arg before receiver

## Symptom
For `s.normalize(form)` with side-effecting `s` and `form`, observable order is
reversed (arg evaluated before receiver).

## Location
`src/codegen/string-ops.ts:2110-2134`: for a non-literal form it compiles+drops
the argument (`:2129`) then compiles the receiver (`:2134`).

## Spec
ECMAScript §13.3.6 / §22.1.3.13 — receiver first, then argument.

## Fix
Compile the receiver into a temp first, then compile/validate/drop the form argument.

## Resolution (2026-06-04)

`src/codegen/string-ops.ts` `normalize` handler (non-literal-form arm): compile
the receiver (`propAccess.expression`) first into a fresh temp local of the
receiver's compiled type (`local.set`), then compile + drop the form argument
(still evaluated for its side effects, now AFTER the receiver), then
`local.get` the temp back as the identity result. The static-literal RangeError
arm and the no-argument arm are unchanged. Note the code location had shifted
to ~L2374 (issue cited L2110-2134).

Test: `tests/issue-1823.test.ts` (4, all pass) — a side-effecting receiver and
form each stamp a monotonic tick; asserts `recvAt < formAt` (the old order gave
`recvAt > formAt`); plus a guard that the form is still evaluated for side
effects, and two identity checks (literal + non-literal valid form return the
receiver unchanged). `tsc`/`biome`/`prettier` clean.

