---
id: 1849
title: "Refactor diverged copy-paste (super dispatch, closure drainers, resolveVec, extern_has, typed-default)"
status: wont-fix
completed: 2026-07-12
created: 2026-06-04
updated: 2026-07-12
superseded_by: 3182
# 2026-07-12: SUBSUMED into the #3182 bloat-elimination epic (slices S4/S5)
# with refreshed evidence. Per-item disposition (see #3182 "D4" table):
# super-dispatch pair → S4 (still duplicated, new-super.ts:545/666);
# closure drainers → S5 (now ×3: runtime.ts:2938/3031/10605);
# resolveVec → ALREADY FIXED (resolveVecForElementImpl, ir/integration.ts:960);
# __extern_has ×2 → re-verify, likely legitimately distinct after #2741/#2617;
# typed-default blocks → mostly fixed via pushDefaultValue (new-super.ts:122/642).
priority: low
feasibility: medium
task_type: refactor
area: codegen
goal: maintainability
sprint: Backlog
---
# #1849 — consolidate diverged duplicate logic (bug-magnets)

Duplicated logic that has already partially diverged, found in the 2026-06-04 review:

- `compileSuperElementMethodCall` ≈ `compileSuperMethodCall`
  (`src/codegen/expressions/new-super.ts:322` vs `:202`); no-class/no-parent
  fallbacks already differ. Extract one shared helper.
- Two closure-iterable drainers with different loop caps / field resolution
  (`src/runtime.ts:1626` vs `:1720`). Unify with a strategy param.
- `resolveVec` duplicated verbatim (`src/ir/integration.ts:864` & `:985`).
- `__extern_has` `in`-operator block emitted twice (`src/codegen/binary-ops.ts:648` & `:730`).
- ~7× copy-pasted "emit typed default value" block in the super-access helpers
  (`new-super.ts`); `defaultValueInstrs`/`pushDefaultValue` already exist.
- `operandValType`/`operandIrType` carry an unused `localDefs` param
  (`src/ir/verify.ts:393`).

## Fix
Extract shared helpers; replace the typed-default blocks with `pushDefaultValue`.

