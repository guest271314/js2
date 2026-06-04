---
id: 1819
title: "Logical assignment (??= ||= &&=) reads globals at wrong (un-offset) index"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: low
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1819 — logical-assignment reads globals at the wrong index

## Symptom
With import globals present (string pool etc.), `g ??= x` / `g ||= x` / `g &&= x`
on a captured/module ref-typed global mis-evaluates (skips the null/undefined
branch because `varType` wrongly falls back to f64).

## Location
`src/codegen/expressions/assignment.ts:3159` and `:3170` use the raw absolute
index `ctx.mod.globals[capturedIdx]` / `[moduleIdx]`. Every other access in the
file wraps with `localGlobalIdx(ctx, …)` (lines 260/276/590/2198/2236/2594/4536/
4568). `localGlobalIdx` subtracts `numImportGlobals`. **Verified by hand.**

## Fix
`ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)]` and likewise for `moduleIdx`.

