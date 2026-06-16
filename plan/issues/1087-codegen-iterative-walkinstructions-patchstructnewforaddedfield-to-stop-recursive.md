---
id: 1087
title: "codegen: iterative walkInstructions + patchStructNewForAddedField to stop recursive walker composing with compile stack under tight CI stack budgets"
status: done
created: 2026-04-11
updated: 2026-06-03
completed: 2026-06-03
priority: critical
feasibility: easy
reasoning_effort: low
task_type: bugfix
goal: ci-hardening
sprint: Sprint-41
---
# #1087 — Iterative `walkInstructions` + `patchInstrs` to eliminate recursive-walker/compile-stack composition

## Problem

`src/codegen/walk-instructions.ts:14-19` implements `walkInstructions` as a
recursive walk over Wasm instruction trees:

```ts
export function walkInstructions(instrs: Instr[], visitor: (instr: Instr) => void): void {
  for (const instr of instrs) {
    visitor(instr);
    walkChildren(instr, (child) => walkInstructions(child, visitor));
  }
}
```

JS call-stack depth here is proportional to the **maximum Wasm block
nesting** across a body (body / then / else / catches[].body / catchAll).

This walker is invoked by `shiftLateImportIndices` (late-imports.ts), which
is called from `flushLateImportShifts` — a helper that fires **every time**
a new late import is added mid-compile. dev-1053 surfaced the
`flushLateImportShifts → shiftLateImportIndices → walkInstructions` chain
while investigating the 2026-04-11 CI baseline drift (#1080). There are
30+ call sites for `flushLateImportShifts` in codegen, including one newly
added in PR #107 (`compileNewExpression` DataView block).

The flush is triggered synchronously **from inside already-deep codegen
stack frames**: `compile → compileStatement → compileExpression →
compileNewExpression → flushLateImportShifts → shiftLateImportIndices →
walkInstructions → (recursive walker)`. Combined JS stack depth becomes:

```
depth(compileStack) + depth(walkInstructions) ≈ O(compile_depth) + O(wasm_block_depth)
```

Additively, not max, because the walker runs synchronously inside an
unreturned compile frame.

Under GitHub Actions `runs-on: ubuntu-latest` (cgroup-constrained V8 stack
budget, tighter than local dev containers), the composition trips
`RangeError: Maximum call stack size exceeded` at `compile_ms=0`. Local
reproduction fails because the dev V8 budget has significantly more
headroom.

The same file has a second recursive walker with the identical failure
mode: `patchStructNewForAddedField` → inner `patchInstrs` function at
`src/codegen/expressions/late-imports.ts:228-254`. No depth guard; same
block-nesting recursion pattern.

## Why this is the class fix

- **Scope**: addresses the *class* of bug (recursive walker called from
  inside recursive codegen frames), not a single-PR revert. Any future PR
  that adds another call site to `flushLateImportShifts` or
  `patchStructNewForAddedField` inherits the fix.
- **Narrow diff**: two functions, iterative rewrite, same public
  signatures, no call-site changes needed. Bounded review surface.
- **Composable with #1085**: `bodyUsesArguments` iterative rewrite is a
  sibling defensive hardening for the same class; this issue and #1085
  ship as two separate PRs for narrow review.

## Fix plan

1. **`src/codegen/walk-instructions.ts`** — rewrite `walkInstructions`
   iteratively using an explicit frame stack
   `{ arr: Instr[]; i: number }[]`. Pre-order semantics preserved (visit
   parent before children, siblings in source order). JS stack depth
   becomes O(1).

2. **`src/codegen/expressions/late-imports.ts:228-254`** — rewrite the
   inner `patchInstrs` function iteratively using an `Instr[][]` work
   queue. Reverse-index iteration preserved inside each array (so
   `splice` at index i doesn't revisit inserted elements). Children
   collected from each instr *before* splice, so the captured `instr`
   reference is stable.

3. **No call-site signature changes**. No new exports. No other files
   touched.

## Acceptance criteria

- [ ] `src/codegen/walk-instructions.ts` `walkInstructions` converted to
      iterative DFS with explicit frame stack
- [ ] `src/codegen/expressions/late-imports.ts` inner `patchInstrs`
      converted to iterative work-queue form
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test -- tests/issue-1064.test.ts` → 6/6 pass (DataView tests
      still work through the new walker)
- [ ] `npm test -- tests/issue-1053.test.ts` → 9/9 pass (arguments-length
      tests still green)
- [ ] `npm test -- tests/equivalence.test.ts` → no new failures vs main
- [ ] PR CI on the sharded baseline shows recovery vs. the post-#96/#107
      broken baseline (target ≥ 22,100 pass)

## Dependencies

- Blocks recovery of #1080 (CI baseline drift umbrella) if this turns out
  to be the dominant contributor (pending PR #113 result for #107 revert).
- Independent of #1085 (`bodyUsesArguments` iterative) — they ship as two
  separate PRs.
- Companion to #1086 (`bodyUsesArguments` dedup+memo follow-up).

## Risks

- **Semantics drift**: the iterative rewrite must preserve visitor
  pre-order semantics exactly. Mitigation: explicit frame stack with
  index cursor, children pushed in reverse so first child is processed
  first. Verified against issue-1064 test suite.
- **patchInstrs splice semantics**: reverse iteration + splice-at-i
  semantics preserved. Children enumeration captures `instr` reference
  before the splice, so child arrays belong to the original instr, not
  the inserted default value.
- **Other call sites of walkInstructions**: 7+ call sites across codegen
  use `walkInstructions` indirectly. All inherit the iterative behavior
  transparently — no API changes.

## Notes

- Audit trail:
  - PR #112 (revert #96) failed to recover the baseline — proving #96 is
    not the sole culprit
  - dev-1031 re-audited #107 under stack-deepening lens, surfaced the
    `walkInstructions` recursion via `flushLateImportShifts` chain
  - dev-1053 independently surfaced the same chain
  - Fix drafted in worktree `.claude/worktrees/issue-1053-stack-depth-fix`
    on 2026-04-11, typecheck clean, 15/15 tests pass locally (1064 + 1053)
- Companion draft to #1085 and #1086. Two-PR split for narrow review:
  - PR A (this issue, #1087): `walkInstructions` + `patchInstrs` iterative
  - PR B (#1085): `bodyUsesArguments` iterative
- Held for push pending PR #113 (#107 revert) CI signal.
