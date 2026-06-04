---
id: 809
title: "Extract native string helpers from index.ts → native-strings.ts"
status: done
created: 2026-03-26
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: medium
reasoning_effort: high
goal: standalone-mode
sprint: 59
subtask_of: 688
---
# #809 — Extract native string helpers from index.ts → native-strings.ts

## What moves

~2,800 lines — the native string infrastructure:

- `ensureNativeStringHelpers` (line 3833, 2,561 lines — single largest function in index.ts)
- `registerNativeStringTypes` (line 2820)
- `nativeStringType` (line 3808)
- `nativeStringTypeNullable` (line 3815)
- `flatStringType` (line 3822)

## Validation

1. `npm test` must pass
2. Compile with `--nativeStrings` flag, verify output matches
3. Compile without flag, verify no regressions
4. No behavior change

## Risk: LOW

`ensureNativeStringHelpers` is a self-contained monster — it registers types and helper functions for WasmGC string arrays. Called once during module setup. The type accessor functions (`nativeStringType` etc.) are simple getters exported for use by other modules.

## Complexity: S (despite line count — it's one big function + 4 tiny ones)

## Resolution (2026-06-04)

Already done on main. The extraction this issue describes has landed
incrementally over prior sprints:

- `src/codegen/native-strings.ts` (5,933 lines) now holds
  `ensureNativeStringHelpers`, `nativeStringType`, `nativeStringTypeNullable`,
  and `flatStringType` (defined at lines 203 / 15 / 185 / 192).
- `registerNativeStringTypes` was extracted to
  `src/codegen/registry/types.ts:200` (called from
  `src/codegen/context/create-context.ts:212`).
- `src/codegen/index.ts` imports these from `./native-strings.js`
  (lines 89-96) and re-exports them for public-API compatibility
  (lines 100-115). No local definition of any of the five functions
  remains in `index.ts`.

No code change required — closing as done.
