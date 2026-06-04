---
id: 1839
title: "addStringImports late-index shift omits pendingInitBody / nativeStrHelpers / startFuncIdx"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1839 — late string-import shift misses targets

## Symptom
When the first string usage occurs inside a function body (not module-init), the
module-init body's `call`/`ref.func` indices are not bumped, so `__module_init`
calls the wrong functions. Also bites plain `--nativeStrings` in JS-host mode
(`nativeStrHelpers` left stale).

## Location
`src/codegen/index.ts:6138-6220` (`addStringImports`) hand-rolls the func-index
shift but, unlike the canonical `shiftLateImportIndices`
(`src/codegen/expressions/late-imports.ts:174-203`) and `addUnionImports`
(`:7572-7602`), omits `ctx.pendingInitBody`, `ctx.nativeStrHelpers`, and
`ctx.mod.startFuncIdx`.

## Fix
Replace the inline shift with a call to `shiftLateImportIndices` (single source of
truth), or add the three missing shift targets.

