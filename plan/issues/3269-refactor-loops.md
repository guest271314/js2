---
id: 3269
title: "refactor(codegen): break up loops.ts god-file — extract analysis + for-of-destructuring + for-await helpers, DRY dedups"
status: done
completed: 2026-07-14
sprint: current
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/senior-dev-loops
# Relocation-shift ratchet allowances (#3131).
# for-of-destructuring.ts: this PR's own verbatim extraction (LOC crosses 1500;
#   the getTypeAtLocation/ctxChecker sites are RELOCATED from loops.ts, total
#   usage conserved). array-prototype-borrow.ts (#3264) and expressions/calls.ts
#   (#3267) are pre-existing whole-tree oracle-ratchet drift inherited from
#   sibling #3182 splits — re-waived here per the established practice (#3267
#   waives the same way) until the committed baseline is reseeded on main.
loc-budget-allow:
  - src/codegen/statements/for-of-destructuring.ts
oracle-ratchet-allow:
  - src/codegen/statements/for-of-destructuring.ts
  - src/codegen/array-prototype-borrow.ts
  - src/codegen/expressions/calls.ts
---

## Problem

`src/codegen/statements/loops.ts` is a ~6.6k-line god-file mixing pure
static-analysis predicates, the for-of loop-variable destructuring subsystem,
`for await` sync-drive helpers, and the loop drivers themselves. It also carries
several copy-pasted idioms (break/continue depth bookkeeping, block-scoped shadow
save/restore, `block{loop{…}}` assembly, assign-target-local resolution, global
writeback, lazy env-import registration, the compound-assignment operator
switch).

## Scope

Behaviour-preserving GOD-FILE breakdown + DRY cleanup. Emitted Wasm MUST stay
byte-for-byte identical (`scripts/prove-emit-identity.mjs`), `tsc --noEmit` at 0.

Extractions (verbatim moves into new sibling modules):
- `src/codegen/statements/loop-analysis.ts` — pure predicates
  (`detectI32LoopVar`, `isIncreasingStep`, `loopBodyMutatesIndexOrArray`,
  `loopBodyMutatesStringReadInvariants`, `bodyHasMatchingCharRead`,
  `findHeadBindingsCapturedByClosures`, `findAllNamesCapturedByClosuresInForLoop`,
  `findBodyLocalLexicalNames`, `collectBindingNames`, `forOfDstrNeedsInboundsUndef`,
  `bindingPatternHasDefaultOrNested`, `assignPatternHasDefaultOrNested`,
  `isStaticNullishReceiver`, `collectForInHeadClosureCaptures`).
- `src/codegen/statements/for-of-destructuring.ts` — the for-of loop-variable
  head-binding destructuring subsystem.
- `src/codegen/statements/for-await-helpers.ts` — `for await` sync-drive helpers.

DRY dedups (extract one shared helper, replace occurrences), each verified
byte-identical:
- `shiftLoopDepths`, `compileLoopBodyWithShadows`, `blockLoop`,
  `resolveAssignTargetLocal`, `emitGlobalSyncWriteback`, `ensureEnvImport`
  (in `statements/shared.ts`), and `isAssignmentOperator` (in `loop-analysis.ts`).

## Acceptance

- `npx tsx scripts/prove-emit-identity.mjs check` → IDENTICAL (39/39).
- `tsc --noEmit` → 0 errors.
- Relocation-shift ratchets green (per-issue frontmatter allowances only).
- `tests/issue-3269.test.ts` smoke-compiles programs exercising the touched paths.
