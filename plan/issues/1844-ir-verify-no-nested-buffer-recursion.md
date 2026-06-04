---
id: 1844
title: "IR verify doesn't recurse into nested if/try/loop buffers (return-type gate + SSA holes) (residual #1798)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: medium
task_type: bugfix
area: ir
goal: correctness
sprint: 59
parent: 1798
---
# #1844 — IR verifier has a control-flow-nesting hole

Defense-in-depth residual of #1798 (marked done, sprint 58).

## Defect
`src/ir/verify.ts:393-414` (`operandIrType`) and `:141-237`
(`verifyBlock`/`collectUses`) scan only top-level `b.instrs`, never descending into
nested `then`/`else`/`try`/`catch`/`finally`/`forof`/loop body buffers — while
`registerInstrDefs` in lower.ts (`:347-376`) does. So the #1798 return-type
assignability gate is bypassed for values defined inside those buffers
(`actual===null` → `continue`), and SSA single-def/use-before-def invariants inside
nested bodies are unchecked. A mismatch surfaces at instantiate-time (or a hard
lower throw) instead of a clean legacy fallback.

## Fix
Make the verifier recurse into nested instr buffers (reuse the `registerInstrDefs`
traversal).

