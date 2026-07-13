---
id: 3131
title: "loc-budget/coercion-sites gates: end the per-PR baseline-bump merge-conflict churn"
status: done
assignee: ttraenkler/fable-locfix
sprint: 71
created: 2026-07-10
updated: 2026-07-13
completed: 2026-07-10
priority: high
horizon: m
feasibility: hard
model: fable
reasoning_effort: max
task_type: infrastructure
area: ci
language_feature: compiler-internals
goal: maintainability
related: [3102, 2108, 2808, 2942, 3115]
---

# #3131 — loc-budget / coercion-sites gates: no PR-committed baseline bump

## Problem (confirmed by fable-shepherd, 4 re-merges on PR #2835)

Every PR that grows a tracked `src/**/*.ts` file must commit a bump to
`scripts/loc-budget-baseline.json` to pass the `check:loc-budget` gate
(#3102). `--update` reseeds the WHOLE file — every per-file ceiling, the
`totalCeiling` (= current total + headroom), and the `generated` date — so the
committed bump is a snapshot of the _entire tree_ at regen time. Every merge to
main moves that snapshot (43 baseline commits on main in the 10 days to
2026-07-10), so **every open PR's committed bump re-conflicts on that file
after every merge**, even when the src changes auto-merge clean. PR #2835
(+12 LOC) re-drifted 4× and was effectively unlandable by hand during an
active queue; the whole +12/+8/+2 stack (#2835/#2839/#2842/#2843) was held on
this. `scripts/coercion-sites-baseline.json` has the same churn class: PRs
that add a coercion site commit a bump that conflicts with the post-merge
refresh commits `promote-baseline` pushes to main.

## Root cause

The gate's _memory_ (the committed baseline) is coupled to the PR's
_change-set_. The gate is already change-scoped (#3102: it blames only the
change-set's own growth, diffed against the merge base) — but its escape
hatch for intentional growth still routes through a shared committed file,
which turns a single-writer ratchet into an N-writer conflict hotspot.

## Fix (option b — structural): the PR gate never needs the committed baseline

Both gates now derive everything they need for a change-set from **git
itself** when a diff base is resolvable:

- **Base resolution** (`scripts/lib/change-scope.mjs`, shared): in CI
  (`pull_request` / `merge_group` / `push`), the checked-out `HEAD` is
  GitHub's synthetic merge commit whose **first parent is the exact base tree
  the change-set was built on** — race-free even while main advances mid-run,
  available at `fetch-depth: 2`. Locally, `git merge-base origin/main HEAD`
  (the fork point) is exact for the same reason. Fallback order:
  `LOC_GATE_BASE` env → CI `HEAD^1` (when `HEAD` is a merge) → `merge-base` →
  `origin/main` tree-diff → legacy whole-tree-vs-committed-baseline mode.
- **Per-file ceiling = the file's size at the base.** A change-set fails only
  if it _grows_ a file that was already over the 1,500-LOC threshold at the
  base, or newly pushes a file over the threshold. No committed ceiling is
  consulted — so a drifted/stale committed baseline in the merged tree can
  never fail (or wrongly pass) a PR. Shrinkage banks **automatically**: once
  a shrink merges, every later change-set's base contains the smaller file.
- **Intentional growth hatch moved out of the shared file**: a change-set
  grants itself an allowance by listing repo-relative paths under
  `loc-budget-allow:` (resp. `coercion-sites-allow:`) in the YAML frontmatter
  of **any `plan/issues/*.md` file the change-set itself adds or modifies**
  (i.e. the PR's own issue file). Unique path per PR ⇒ conflict-free by
  construction; the intent is documented next to the WHY and visible in the
  diff; works identically in `pull_request`, `merge_group`, and local runs
  (it needs only the tree + the diff, no commit messages — the quality job's
  shallow checkout makes message-trailer hatches unreliable).
- **Total-LOC backstop** becomes per-change-set: fail when the change-set's
  net src LOC delta exceeds the headroom (75,000) without a `total`
  allowance. Equivalent teeth to the committed `totalCeiling` (which was
  re-based on every reseed anyway), zero shared state.
- **The committed baselines remain** for the `--all` audit, dashboards, and
  the no-git fallback — but they are now written **only post-merge on main**
  (`promote-baseline` in test262-sharded.yml + the hourly
  baseline-summary-sync fallback, both incl. their #3115 re-anchor paths),
  making main the sole writer. `--update` now skips the write when nothing
  but the `generated` date would change, so stable-main refreshes don't
  churn commits.

## Why not option (a) (custom merge driver regenerating the baseline)?

A merge driver only fires on _local_ merges — GitHub's server-side merge
queue and the `refs/pull/N/merge` synthesis don't run client merge drivers,
so the queue-side conflicts (the actual blocker) would persist. Option (b)
removes the conflicting writes entirely instead of resolving them faster.

## Gate-protection validation (the four cases)

1. **No-src-change PR passes even with a drifted baseline in the merged
   tree** (the #2808 wedge condition): scoped mode never reads the committed
   file; empty src diff ⇒ OK.
2. **Touch+grow fails**: growing `src/codegen/index.ts` past its base size
   fails with the file, the base size, and the delta; a new >1,500-LOC file
   fails as a new god-file. Adding the path to `loc-budget-allow:` in the
   PR's issue file (and only that) admits it, with the grant logged.
3. **Touch+shrink passes**: a file below its base size never faults, even
   when the committed baseline is stale in either direction.
4. **Ratchet banks the shrink**: growth is judged against the base tree, so
   the first change-set after a merged shrink already gates at the smaller
   size (structural banking — no `--update-on-decrease` ceremony needed);
   the post-merge refresh writes the lower ceiling into the committed file
   for the audit/fallback path.

Merge-queue safety (the #3102 invariant — never blame a PR for another PR's
growth) is _strengthened_: `HEAD^1` in the merge group is the previous queue
entry, so each entry is judged on exactly its own delta, and unrelated main
advances can never enter scope (previously the `origin/main`-tip fallback
could over-include on a mid-run main advance; the committed ceiling masked
it).

## Files

- `scripts/lib/change-scope.mjs` (new) — base resolution, changed-path
  listing, frontmatter allowance parsing (shared by both gates).
- `scripts/check-loc-budget.mjs` — scoped gate rewritten to be
  baseline-free; legacy whole-tree mode kept for `--all`/no-git;
  `--update` made idempotent modulo the `generated` date.
- `scripts/check-coercion-sites.mjs` — same scoping (token counts computed
  on base blobs vs working tree); legacy mode kept as fallback and for the
  writer modes.
- `.github/workflows/ci.yml` — `quality` checkout `fetch-depth: 2` (exposes
  `HEAD^1`); step comments updated.
- `.github/workflows/test262-sharded.yml`,
  `.github/workflows/baseline-summary-sync.yml` — post-merge
  `check-loc-budget.mjs --update` + staging next to the existing
  coercion-sites refresh (both normal and #3115 re-anchor paths).

## Validation runs (2026-07-10, worktree + sim clones)

- Case 1: zero-src-change change-set → both gates OK in scoped mode; repeated
  with a deliberately corrupted committed baseline (ceiling 100, totalCeiling
  5; coercion entry zeroed) → still OK (committed files provably unread).
- Case 2: `src/codegen/index.ts` +2 → FAIL `16627 > 16625 (+2)`; frontmatter
  `loc-budget-allow: [src/codegen/index.ts]` in this issue file → PASS with
  grant logged. New untracked 1,600-line `src/codegen/probe-giant.ts` → FAIL
  as new god-file. `__is_truthy(` use added to `math-helpers.ts` → coercion
  FAIL `0 → 1 (__is_truthy 0→1)`; inline `coercion-sites-allow:` → PASS.
- Case 3: `binary-ops.ts` −30 → PASS (net −30); PASS again with the committed
  ceiling forged to 10 (stale-baseline immune).
- Case 4: temp commit shrinking `binary-ops.ts` 4474→4444, then +10 regrow
  gated against it (`LOC_GATE_BASE=HEAD`) → FAIL `4454 > 4444 (+10)` even
  though origin/main still holds 4474 (structural banking). `--update` wrote
  the 4444 ceiling; immediate rerun → "already current … not rewritten"
  (idempotent, no stable-main commit churn).
- CI arm: local clone, queue-style `--no-ff` merge (parent1 = base) with
  `GITHUB_ACTIONS=true GITHUB_EVENT_NAME=merge_group` → base
  `ci-merge-parent(merge_group)`, scope = the PR delta only; growth in the
  merged tree FAILS and the merged issue-file allowance admits it. Repeated
  from a `--depth 2` clone (exactly CI's fetch-depth) → identical results.
  `push` event with a non-merge HEAD falls through to merge-base. No-git
  (`GIT_DIR=/nonexistent`) falls back to the legacy committed-baseline gate,
  which still catches growth (exit 1) and passes clean trees; `--all` audit
  OK.
- `update-issues.mjs` write-mode normalization preserves the allowance keys
  (unknown frontmatter blocks round-trip via `extras`; `DROPPED_KEYS` empty).
