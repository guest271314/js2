---
id: 1861
title: "promote-baseline never refreshes main: missing commit + push race freezes the test262 baseline"
status: in-progress
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: tooling
language_feature: compiler-internals
goal: ci-hardening
related: [1528, 1522, 1668, 1218]
---
# #1861 — promote-baseline never refreshes main (missing commit + push race)

## Problem

The `promote-baseline` job in `.github/workflows/test262-sharded.yml` (job
name **"promote merged report to main baseline"**) is the *only* writer of the
committed test262 baseline (`benchmarks/results/test262-current.json`) on
`main`, and the only pusher of the regression-gate baseline JSONL to
`loopdive/js2wasm-baselines`. It has been failing to refresh the baseline,
which froze the committed summary at commit `9ee8e92` for ~146h. A stale
baseline makes the PR `check for test262 regressions` gate produce
false-positive regressions on PR after PR (#1132, #1135).

Two distinct defects in the **"Commit refreshed summary JSON to main repo"**
step:

1. **Missing `git commit`.** Commit `d630e3a04` switched this step from the
   PR-based flow to a direct push but deleted the `git commit` line along with
   the branch/PR plumbing. The current step does `stage_files` (git add) → diff
   checks → `git push origin HEAD:main`, with **no commit in between**. The
   staged baseline changes are never committed, so the push (even when it
   succeeds) carries the unmodified checkout. The committed baseline on `main`
   therefore never moves.

2. **Push race, no retry.** Even with a commit, `git push origin HEAD:main`
   races the merge queue: under heavy throughput `main` advances between the
   job's `checkout` and its push, and the push is rejected:

   ```
   ! [rejected]  HEAD -> main (fetch first)
   error: failed to push some refs to 'https://github.com/loopdive/js2'
   hint: Updates were rejected because the remote contains work that you do not have locally.
   ```

   There is no fetch/rebase/retry, so a single lost race drops the refresh
   entirely.

The baselines-repo push (**"Push baseline artifacts to js2wasm-baselines
repo"**) can lose the same race against a concurrent promote-baseline run on a
separate `main` push, and also lacks a retry.

## Fix

In `.github/workflows/test262-sharded.yml` `promote-baseline` job, **only the
push machinery** is touched (no threshold / shard-count / regression-gate
logic changes):

- **"Commit refreshed summary JSON to main repo"**: actually `git commit` the
  staged summary JSON (restoring the `[skip ci]` trailer so the push does not
  re-trigger the shard matrix), then wrap the push in a
  fetch → `rebase --autostash` → push retry loop (5 attempts, linear backoff).
  The locally-generated JSON is committed *before* the loop so the rebase
  replays the baseline commit onto the advanced `origin/main`. A persistent
  failure after all retries exits non-zero (only the transient race is
  swallowed).
- **"Push baseline artifacts to js2wasm-baselines repo"**: wrap its
  commit + `git push` in the same fetch → `rebase --autostash` → push retry
  loop against the baselines repo (`--unshallow` on first fetch so the rebase
  has a merge base; falls back to a plain fetch on later attempts).

The existing remote/auth (persist-credentials for main; SSH deploy key for the
baselines repo) is unchanged — this fix is complementary to the auth switch in
the past PR #490, addressing the fast-forward race rather than authentication.

## Acceptance criteria

- A push to `main` that changes test262 results updates
  `benchmarks/results/test262-current.json` on `main` within one
  promote-baseline run.
- A push race (`fetch first` rejection) is retried, not dropped.
- A persistent (non-race) push failure still fails the step.
- No change to conformance thresholds, shard counts, or regression-gate logic.
