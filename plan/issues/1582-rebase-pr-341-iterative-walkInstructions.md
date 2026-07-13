---
id: 1582
title: "Rebase PR #341 — refactor: iterative walkInstructions (250 commits behind)"
status: wont-fix
completed: 2026-07-12
created: 2026-05-22
updated: 2026-07-12
# 2026-07-12 (#3182 groom): closed as superseded. Both halves of PR #341's
# value landed by other routes: (1) walkInstructions is ALREADY iterative on
# main (src/codegen/walk-instructions.ts:23-39 — explicit frame stack, O(1)
# JS call depth); (2) the `as unknown as Instr` elimination shipped via #1095
# (per CLAUDE.md), and the remaining cast debt (129 double-casts + 13,359
# single `as Instr`, measured 2026-07-12) is owned by the #3107 codemod,
# which does a fresh mechanical pass instead of a hopeless 250+-commit
# rebase. Rebasing PR #341 has no residual value.
priority: medium
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
goal: code-modularity
sprint: Backlog
origin: surfaced 2026-05-22 during merge-queue drain audit
---
# #1582 — Rebase PR #341 (iterative walkInstructions + patchInstrs refactor)

## Context

PR #341 (`refactor(#1095): remove all 279 \`as unknown as Instr\` casts`) was
opened against a 250-commit-old main. Touches src/codegen broadly. The
merge queue cannot pull it in (`mergeStateStatus: DIRTY` — massive conflict).

Originally aimed at removing the `as unknown as Instr` cast workarounds.
The diff probably no longer applies cleanly because many of those casts
have been touched in unrelated changes since.

## Goal

Decide whether the value is worth the rebase cost:

1. **Smoke-test current main**: how many `as unknown as Instr` casts remain
   in `src/codegen/**`?  If <50, the PR's original premise is already
   half-resolved by drift — close as obsolete.
2. **If >100 casts remain**: dispatch an agent to rebase. Strategy:
   - Create a fresh branch from current main
   - Cherry-pick each PR #341 commit, resolving conflicts per file
   - Drop commits whose changes are already in main
   - Open a new PR (don't try to update #341 in place — too lossy)

## Acceptance criteria

- [ ] `src/codegen` cast audit done — counts reported in this issue
- [ ] Decision recorded: rebase OR obsolete
- [ ] If rebased: new PR opened against current main, original PR #341 closed
      with link to the successor
- [ ] If obsolete: PR #341 closed with explanation

## Files affected by PR #341

```
src/codegen/array-methods.ts
src/codegen/class-bodies.ts
src/codegen/closures.ts
src/codegen/dead-elimination.ts
src/codegen/expressions.ts
src/codegen/expressions/assignment.ts
... (+ many more)
```

The breadth makes this hazardous to mechanical rebase — likely needs
hand-resolution per file. Reserve for an Opus session.

## Implementation Plan

Dispatch a `senior-developer` agent with `isolation: worktree`. Prompt:

> Read `plan/issues/1582-rebase-pr-341-iterative-walkInstructions.md`.
> First do the cast audit (acceptance criterion 1) and report back. If the
> count justifies the rebase, follow the strategy in the issue. If not,
> close PR #341 with the audit numbers as the rationale.
