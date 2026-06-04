---
id: 1861
title: "promote-baseline never refreshes main: missing commit + push race freezes the test262 baseline"
status: in-progress
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
status_note: "follow-up 2026-06-04 — main-repo push re-instated on MAIN_DEPLOY_KEY (SSH) to bypass GH013; see ## Follow-up"
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

## Follow-up (2026-06-04) — main push auth: GITHUB_TOKEN → MAIN_DEPLOY_KEY (SSH)

The #1156 fix above restored the dropped `git commit` and the
fetch → `rebase --autostash` → retry loop, but deliberately left the push
**auth** alone (it pushed `origin HEAD:main` over HTTPS with
`persist-credentials: true`, i.e. as `github-actions[bot]` via `GITHUB_TOKEN`).
That auth path is the remaining failure: the repo ruleset *"main: merge queue +
required checks"* (id `16700772`) rejects any direct `GITHUB_TOKEN` push to
`refs/heads/main`:

```
remote: error: GH013: Repository rule violations found for refs/heads/main
```

The ruleset's `bypass_actors` list, however, includes **DeployKey (always)**
(`{"actor_id": null, "actor_type": "DeployKey", "bypass_mode": "always"}`), so a
push authenticated with a repo **deploy key** bypasses it. PR #490 originally
wired the main push onto `ssh-key: MAIN_DEPLOY_KEY`; PR #725/#896 regressed it
back onto `GITHUB_TOKEN`, re-introducing the GH013 block.

**This follow-up** re-instates the deploy-key push (per #490) while keeping the
#1156 fixes intact. In the *"Commit refreshed summary JSON to main repo"* step:

- The step env switches from `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to
  `MAIN_DEPLOY_KEY: ${{ secrets.MAIN_DEPLOY_KEY }}`.
- The deploy key is loaded **inline** via `ssh-agent` + `ssh-add` +
  `ssh-keyscan github.com`, mirroring the sibling *"Push baseline artifacts to
  js2wasm-baselines repo"* step (which uses `BASELINE_DEPLOY_KEY` the same way).
  This is done inline rather than on the checkout's `ssh-key:` so the checkout
  keeps its HTTPS `origin` for other steps.
- A dedicated SSH remote `deploykey` →
  `git@github.com:${{ github.repository }}.git` is added; the fetch + rebase +
  push loop now runs against `deploykey/main` / `git push deploykey HEAD:main`.
- The `git commit … [skip ci]` and the 5-attempt fetch →
  `rebase --autostash` → push retry loop from #1156 are unchanged.
- The baselines-repo push step and all required-check / regression-gate logic
  are untouched.

**Operational dependency:** `MAIN_DEPLOY_KEY` must exist as an Actions secret
holding the **private** half of the write-access deploy key registered on
`loopdive/js2` (the deploy key titled `MAIN_DEPLOY_KEY`, id `152733867`,
`read_only: false`, already exists on the repo). The step fails fast with an
explicit error if the secret is empty/unset.
