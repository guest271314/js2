---
id: 1844
title: "IR verify doesn't recurse into nested if/try/loop buffers (return-type gate + SSA holes) (residual #1798)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
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

## Resolution
Added two helpers to `src/ir/verify.ts`:
- `nestedBuffers(instr)` — yields the direct nested instruction buffers carried
  by an instr (then/else, loop cond/body/update, for-of body,
  try/catch/finally), mirroring `registerInstrDefs` in lower.ts.
- `forEachInstrDeep(instr, visit)` — recurses an instr and all its nested
  buffers.

Three consumers now recurse:
1. **`operandIrType`** — `forEachInstrDeep` over every block's instrs, so a value
   defined inside a nested buffer (e.g. a try body or if-arm) is found instead of
   returning `null` and silently `continue`-ing past the #1798 return-type gate.
2. **`verifyBlock`** — its straight-line walk was refactored into a recursive
   `walkBuffer` that threads the same `localDefs`/`defs` accumulator into nested
   buffers, so SSA duplicate-def + use-before-def + box/unbox/tag.test structural
   checks all fire inside nested bodies. `while.loop`/`for.loop` walk their `cond`
   buffer before validating the `condValue` use (the value is produced by the cond
   buffer), avoiding a spurious use-before-def.

## Test Results
`tests/issue-1844.test.ts` (4 cases):
- valid value defined inside an if-arm and returned via the if result → verifies clean (no false positive).
- duplicate SSA def inside a nested if-arm → flagged (was missed pre-fix).
- i32 value defined inside a try body returned from an f64-result function → #1798 return-type gate now fires (was bypassed pre-fix).
- use-before-def inside a nested if-arm → flagged (was missed pre-fix).

Pre-fix: 3/4 fail (the three bug cases slip past the verifier). Post-fix: 4/4 pass.
IR-path smoke: `function f(a){ if(a>0){let x=a*2;return x;} else {return 0;} }` compiles
through `experimentalIR` and runs correctly (f(5)=10, f(-3)=0). No demotion regression.
Pre-existing unrelated IR test-harness failures (`__box_number` LinkError;
`func.params is not iterable`) are identical with and without this change.
