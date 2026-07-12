---
id: 803
title: "Extract call dispatch from expressions.ts → calls.ts"
status: done
completed: 2026-07-12
created: 2026-03-26
updated: 2026-07-12
# 2026-07-12 (#3182 groom): closed as landed — the extraction happened via the
# expressions/ split: compileCallExpression + the whole call cluster now live
# in src/codegen/expressions/calls.ts (18,753 LOC; plus calls-guards/
# calls-closures/calls-optional). Refactoring the monster itself continues
# under #742.
priority: medium
feasibility: easy
reasoning_effort: medium
goal: maintainability
sprint: Backlog
subtask_of: 688
---
# #803 — Extract call dispatch from expressions.ts → calls.ts

## What moves

~4,467 lines — the largest single function cluster in expressions.ts:

- `compileCallExpression` (line 8471, 4,467 lines — the monster)
- `compileClosureCall` (line 8066)
- `compileCallablePropertyCall` (line 8158)
- `compileConditionalCallee` (line 12938)
- `compileExpressionCallee` (line 13178)
- `compileIIFE` (line 13406, 281 lines)
- `compileSuperMethodCall` (line 13695)
- `compileSuperElementMethodCall` (line 13786)
- `compileExternMethodCall` (line 15590)
- `compileSpreadCallArgs` (line 15860)
- `compileConsoleCall` (line 15975)
- `compileConsoleCallWasi` (line 16716)
- `getFuncParamTypes` (line 8038)
- `flattenCallArgs` (line 14222)

~7,000 lines total.

## Validation

1. `npm test` must pass (equivalence tests)
2. Compile 5 diverse test262 files and verify output matches pre-refactor
3. No new exports from calls.ts beyond what expressions.ts already exported
4. `compileExpressionInner` stays in expressions.ts — calls.ts functions are called from there

## Risk: LOW-MEDIUM

These functions form a natural cluster (all call-related). The main risk is circular imports — calls.ts will need to import `compileExpression` from expressions.ts, and expressions.ts will import call functions from calls.ts. TypeScript handles this fine as long as there are no top-level side effects.

## Complexity: M
