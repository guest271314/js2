---
id: 3552
title: "CI gap: untouched guard tests run in NO required check — #3503 landed a red tests/issue-3471.test.ts on main; add a curated required guard suite to `quality`"
status: done
created: 2026-07-23
updated: 2026-07-24
completed: 2026-07-23
priority: high
feasibility: medium
reasoning_effort: max
task_type: infra
area: ci
goal: core-semantics
sprint: 76
horizon: s
assignee: ttraenkler/senior-dev-3551
related: [3551, 3503, 3008, 3471]
---

# CI gap: untouched guard tests run in no required check

## Problem (the #3503 post-mortem, CI half)

#3503 merged green on 2026-07-23 while regressing
`tests/issue-3471.test.ts` — a guard test it never touched. Why no required
check objected:

- **`quality` (ci.yml)** runs root tests only via "Changed root test files
  must pass (#3008)" — scoped to files the PR itself ADDS or MODIFIES
  (`git diff --diff-filter=AM`). #3503 didn't touch issue-3471 → never ran.
  (That step is also `if: github.event_name == 'pull_request'` — it doesn't
  even run in the merge group.)
- **`cheap gate (main-ancestor + lint)`** (test262-sharded.yml) runs no unit
  tests at all — ancestry + lint only.
- **`merge shard reports`** (test262-sharded.yml) aggregates test262
  conformance shards — the regression's test262 impact was inside existing
  fail-bucket noise; root vitest files are not part of it.
- **issue-tests.yml** (the #3008 post-merge half) runs the full ~2,100-file
  root suite sharded — it DID go red on main within one run (runs
  30006146586 / 30007598816, 2026-07-23 12:13/12:35 UTC), but it is
  post-merge and non-required: it detects, nothing enforces. Red-on-main
  relies on someone watching.

So the class "guard test protecting an invariant in a surface the PR
changed, but not itself touched by the PR" had **zero required coverage**.

## Corroborating incident (same gap, 8x the latency)

Not a one-off: `tests/issue-1539-standalone-regex.test.ts` (80/178 hard CEs,
`ir/from-ast: arg 0 of new RegExp expects externref but got string`) was
regressed by PR #3483 on 2026-07-21 17:48 and sat UNDETECTED on main for
~2 days until 2026-07-23 — green PRs, red main, precisely this gap. Bisect
table: `plan/issues/3553-ir-extern-coercion-throw-misclassified-invariant.md`
(fixed by PR #3517). Two independent incidents in one week — #3503 at ~6h
detection latency, #3483 at ~2 days — is the pattern this issue closes.

## Why not gate the whole root suite

Deliberate #3008 decision, still correct: the full suite is ~9 CPU-hours
single-fork with a baselined rot backlog (~40% of sampled files). Making it
required would blow up PR latency and instantly block every PR on
pre-existing rot. This issue does NOT reopen that; it adds the missing
narrow layer. (Flagging the broad observation explicitly: the whole root
vitest suite remains ungated per-PR by design — the fix here is curation,
not bulk.)

## Fix (this PR)

A **curated required guard suite** inside the already-required `quality`
job:

- `tests/guard-suite.json` — the manifest + entry criteria (in-file):
  1. guards an invariant a prior PR silently broke on main (regression
     memory, not ordinary coverage);
  2. <60s per file, no test262 submodule/harness inputs (plain
     `vitest run <file>` on a bare checkout);
  3. green on current main (a red entry blocks every PR).
     Total budget ~2 minutes; split back to post-merge if it outgrows that.
- `scripts/run-guard-suite.mjs` (`pnpm run test:guard`) — single-fork vitest
  over the manifest; fails loudly on a listed-but-missing file so deleting a
  guard test must be a deliberate manifest edit.
- ci.yml `quality` step "Required guard suite (#3552)" — **no event
  condition**: runs on pull_request, merge_group, AND push, so the merge
  queue re-validates the merged state too (the #3008 changed-files step is
  pull_request-only).

Seeded with the three tests of the #3503 incident: `issue-3471` (the
regressed invariant), `issue-3536` (the counterpart standalone invariant —
keeps the 3471/3536 tension pinned from BOTH sides), `issue-3551` (the
cascade fix's own guard). ~13s locally.

Would this have caught #3503? Yes, at PR time: the branch contained the
regression, the guard step runs issue-3471 unconditionally, `quality` goes
red, the PR never merges.

## Stacking

Stacked on #3551 (`issue-3551-ir-parity-withdraw-cascade` — PR #3513): the
suite includes issue-3471, which is red on main until the #3551 fix lands.
This branch contains those commits, so its own CI is green regardless of
landing order.

## Follow-ups (not this PR)

- Growing the manifest: candidates are the four 2026-07-16 silent
  main-regressions (#1284, JSON.stringify, #3307, #3316) once their guard
  files are verified green + cheap.
- `tests/issue-3553.test.ts` — the cheap sentinel for the #3483/#1539
  incident above (measured 36.2s solo under this suite's exact runner
  settings, ~5s test time; criteria-eligible). NOT added here: it isn't on
  main until the #3517 follow-up lands, and the runner fails loudly on a
  listed-but-missing file by design. The #3553 owner adds the manifest
  entry in that follow-up. The FULL 1539 suite was evaluated and rejected
  on cost — wanted-but-too-expensive: 173.7s green solo (~3x the <60s/file
  bar); it stays post-merge coverage.
- An enforcement loop for issue-tests.yml red-on-main (e.g. auto-filing a
  `[CI-FIX]` task) — detection without a consumer is how today's red runs
  went unnoticed.
