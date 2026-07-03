---
id: 807
title: "Extract Date/Math/console built-ins from expressions.ts → builtins.ts"
status: done
completed: 2026-07-03
created: 2026-03-26
updated: 2026-07-03
priority: medium
feasibility: easy
reasoning_effort: medium
goal: platform
sprint: Backlog
subtask_of: 688
---
# #807 — Extract Date/Math/console built-ins from expressions.ts → builtins.ts

## What moves

~1,500 lines — built-in runtime function compilation:

- `compileMathCall` (line 17086, 381 lines)
- `compileDateMethodCall` (line 16398, 318 lines)
- `ensureDateStruct` (line 16034)
- `ensureDateCivilHelper` (line 16059)
- `ensureDateDaysFromCivilHelper` (line 16259)
- `compileConsoleCall` (line 15975) — if not moved to calls.ts
- `compileConsoleCallWasi` (line 16716)
- `wasiAllocStringData` (line 16780)
- `emitWasiValueToStdout` (line 16800)
- `ensureWasiWriteI32Helper` (line 16841)
- `ensureWasiWriteF64Helper` (line 17004)

## Validation

1. `npm test` must pass
2. Test: `Math.max()`, `Math.floor()`, `new Date()`, `console.log()`
3. No behavior change

## Risk: LOW

These are leaf functions — they emit Wasm but nothing calls back into them from other modules. Console/WASI helpers are entirely self-contained.

## Complexity: S

## Reconciliation — DONE (2026-07-03)

Verified the extraction is complete on `main`:

- The built-in handlers now live in `src/codegen/expressions/builtins.ts`
  (~3,700 LOC): `compileConsoleCall` / `compileConsoleCallWasi`,
  `compileMathCall`, `compileDateMethodCall`, and the Date helper builders
  (`ensureDateStruct`, `ensureDateCivilHelper`, `ensureDateIsoStringHelper`, …).
- They are dispatched from `src/codegen/expressions/calls.ts` (imports at the
  top `from "./builtins.js"`; call sites `compileConsoleCall(...)`,
  `compileMathCall(...)`, `compileDateMethodCall(...)`).
- `src/codegen/expressions.ts` has **zero** residual `Math`/`Date`/`console`
  built-in dispatch (`grep -c` = 0) — so the logic was moved OUT of
  `expressions.ts`, not duplicated. That is exactly this issue's ask.

Flipped during the 2026-07-03 stale-backlog reconciliation.
