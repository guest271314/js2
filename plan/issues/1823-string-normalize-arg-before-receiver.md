---
id: 1823
title: "String#normalize(form) evaluates argument before receiver (wrong eval order)"
status: ready
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

