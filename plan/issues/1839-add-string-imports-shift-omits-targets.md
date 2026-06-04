---
id: 1839
title: "addStringImports late-index shift omits pendingInitBody / nativeStrHelpers / startFuncIdx"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
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

## Resolution
Added the three missing shift targets to `addStringImports`'s inline shift in
`src/codegen/index.ts`, matching `addUnionImports`:
- `ctx.pendingInitBody` is now walked by `shiftFuncIndices` (after the
  `liveBodies` walk) — when the first string usage is inside a function body,
  the module-init body isn't reachable via `funcStack`/`liveBodies` yet, so its
  `call`/`ref.func` indices were missed and `__module_init` called the wrong
  functions.
- `ctx.nativeStrHelpers` entries `>= importsBefore` move up by `delta` — this
  map is read directly by string-lowering call sites and is not a copy of
  `funcMap`, so it must be shifted on its own (was stale under plain
  `--nativeStrings` JS-host mode).
- `ctx.mod.startFuncIdx` moves if it was a defined function at/above the
  insertion point.

(Chose the targeted-addition approach over swapping to `shiftLateImportIndices`
because that helper doesn't itself shift `startFuncIdx` and walks a broader body
set — riskier given the in-flight #809 native-strings extraction on main.)

### Test Results
- `tests/issue-1839.test.ts` (3, all pass): module-init `call` resolves after a
  late string-import shift triggered inside a function body (`moduleVal === 42`);
  two module-init calls both stay correct; the string-concat function that
  triggered the late import compiles + instantiates (helpers resolve to shifted
  indices). All under `nativeStrings: true`.
- End-to-end probe confirmed the wrong-function regression is gone.

