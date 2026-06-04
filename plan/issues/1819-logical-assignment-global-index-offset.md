---
id: 1819
title: "Logical assignment (??= ||= &&=) reads globals at wrong (un-offset) index"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
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

## Resolution
Applied the two-line fix at `assignment.ts:3159` / `:3170` in
`compileIdentifierLogicalAssignment`. Both now wrap the absolute Wasm global
index with `localGlobalIdx(ctx, …)` before indexing the module-globals array,
matching every other global access in the file.

Root cause: `ctx.capturedGlobals` / `ctx.moduleGlobals` store the *absolute*
Wasm global index (import globals included). `ctx.mod.globals` is the
module-defined-globals array, which excludes import globals. Indexing it with
the absolute index lands on the wrong slot (or off the end) once any string
literal adds `string_constants` import globals, so the resolved `type` was
wrong → `varType` fell back to f64 → the null/undefined short-circuit branch was
either skipped (wrong runtime value, e.g. `??=` returned the stale `null`) or
emitted with an f64-typed `if` condition where i32 was expected (invalid Wasm,
`||=` / `&&=`).

## Test Results
`tests/issue-1819.test.ts` — 7/7 pass with the fix. Verified each case FAILS on
the unpatched baseline:
- `??=` (module string|null): baseline returned `"nullxyz"` (skipped null branch)
  → fixed returns `"setxyz"`.
- `||=` / `&&=` (module number): baseline produced invalid Wasm
  (`if[0] expected type i32, found global.get of type f64`) → fixed compiles and
  short-circuits correctly.
- `??=` on a captured global inside a closure: baseline `"nullzzz"` → fixed
  `"viaClosurezzz"`.

Pre-existing unrelated failures in `tests/logical-assignment.test.ts` (11/11,
`Import #0 "string_constants": module is not an object or function`) reproduce
identically on the unpatched baseline — a test-harness instantiation gap, not a
regression from this change.
