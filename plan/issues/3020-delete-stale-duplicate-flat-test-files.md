---
id: 3020
title: "Delete the 2 stale duplicate flat test files PR #2588 missed (broken-import copies superseded by tests/equivalence/)"
status: done
sprint: 69
priority: low
created: 2026-07-03
completed: 2026-07-03
assignee: ttraenkler/dev-team-d
feasibility: easy
reasoning_effort: low
task_type: chore
area: quality-infra
language_feature: n/a
goal: quality-infra
related: [3019, 2588, 3008]
origin: "2026-07-03 — tail cleanup after #3019/#2588: 2 of the 106 broken-import flat copies are duplicates #2588 did not delete"
---

# #3020 — delete the 2 stale duplicate flat test files #2588 missed

## Context

#3019 found 106 `tests/*.test.ts` files silently dead (import `./helpers.js`,
which no longer resolves after the harness moved to `tests/equivalence/`). Of
those: PR #2588 deleted 76 provably-dead duplicates; #3019 restored 28 unique
survivors. That leaves exactly **2** files — flagged in #3019 as
"surfacing failures" — that are in fact **stale duplicate flat copies** #2588's
sweep missed. Their old-copy failures were an artifact of the stale content;
the canonical `tests/equivalence/` copies are what CI runs, and they pass.

## Verification (byte-diff modulo import path, current main)

- `tests/arguments-nested-and-loops.test.ts` — **byte-identical** (modulo the
  broken import path) to `tests/equivalence/arguments-nested-and-loops.test.ts`.
  Pure duplicate.
- `tests/iife-and-call-expressions.test.ts` — **superseded**: the
  `tests/equivalence/` copy is a strictly larger, updated version (uses
  `TemplateStringsArray` where the flat copy uses `string[]`, and adds tests
  e.g. "IIFE returning boolean inside f64-returning function (#720)"). The flat
  copy is an older subset.

Both live equivalence/ copies run in the required `equivalence-shard` CI and
pass, so deleting the dead flat copies loses **zero** coverage — same rationale
as #2588.

## Fix

`git rm` the two dead flat copies. Test-file-only; byte-inert to the compiler
(`src/**`). This completes the #3019/#2588 dedup: every one of the original 106
broken-import flat files is now either restored (28 unique) or deleted (78
duplicate).

## Acceptance criteria

- The 2 stale duplicate flat files are removed; their live `tests/equivalence/`
  counterparts (unchanged) continue to pass CI. [done]
- No compiler-source change. [done]
