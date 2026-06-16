---
id: 2178
title: "standalone baseline floor goes stale because push:main promote-baseline is cancelled by later main pushes (thrash) → standalone-guard blocks every PR on current main"
status: ready
sprint: 63
created: 2026-06-16
updated: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci-infra
area: ci
related: [2149, 1897, 1951, 1528]
origin: "2026-06-16 sprint-62 shepherding — value-rep P1 (#2104/#1503) shifted standalone output; the auto promote-baseline run never landed the new floor, so every PR on current main showed a phantom net -19 standalone and was blocked by the #1897 guard. Manually unblocked via workflow_dispatch force_baseline_refresh."
---

# #2178 — push:main baseline promotion is cancellable → recurring stale-floor deadlock

## Problem

The standalone regression guard (#1897) compares each PR's standalone
test262 result against a **floor** stored in `loopdive/js2wasm-baselines`
(`test262-standalone-current.jsonl`). That floor is supposed to be
re-promoted on every push to `main` by the `promote-baseline` path in
`.github/workflows/test262-sharded.yml`.

When a change lands on `main` that **shifts standalone wasm output**
(e.g. #2104/#1503 "value-rep P1: canonical JsTag + boxToAny
consolidation"), the floor must move with it. But the `push:main`
baseline-refresh run is **cancelled / superseded by the next push to
main before it reaches `promote-baseline`**, so the floor never catches
up. Then **every PR built on current main** shows the same phantom
standalone regression (observed: net **-19**, 23 "wasm-hash change"
regressions, 4 improvements, identical across 3+ unrelated PRs) and is
blocked by the `merge shard reports` required check.

Observed on 2026-06-16:

- Baselines repo HEAD `4b3324802` was promoted for `67c978c8`
  (2026-06-15T22:24Z) — **before** #2104 landed.
- `push:main` refresh run `27588392608` for `8c74365b` reached
  all-30-shards-green, then **reverted to `queued`** when main advanced
  to `e1a0023fc` — i.e. it was cancelled before promoting.
- Net effect: the merge queue could not drain (every standalone PR
  failed the guard), even though the PRs were correct.

This is the same class of failure as #2149 (baseline drift deadlock) but
a **different root cause**: #2149 was a GITHUB_TOKEN/GH013 push failure;
this is **concurrency cancellation** of the promote run.

## Why the existing concurrency comment doesn't cover it

`test262-sharded.yml` already carries a long comment (around the
`concurrency:` block) claiming push:main / workflow_dispatch /
merge_group runs are keyed so a baseline-refresh run "always runs to
completion and reaches promote-baseline." In practice a push:main run
still got cancelled/superseded by a subsequent push:main run on
2026-06-16. Either the group key still collides for two rapid
push:main events, or `cancel-in-progress` is effectively true for the
push:main → push:main case. Needs verification against the actual YAML +
a reproduction.

## Acceptance criteria

1. A change that lands on `main` and shifts standalone output results in
   the baselines-repo floor being re-promoted for that exact `main` SHA,
   **even if more pushes to main happen while the refresh is running**.
   (No window in which the floor is stale-by-a-merged-commit for longer
   than one full sharded run.)
2. Two rapid pushes to `main` do **not** cancel an in-flight
   promote-baseline run; promotion is serialized, not cancelled.
3. A self-check / alert when the floor SHA lags `main` by more than N
   commits (surfaces the deadlock instead of silently blocking every PR).

## Candidate approaches (pick during impl spec)

- **Decouple promotion from the full sharded PR run**: a dedicated
  `promote-baseline` workflow triggered on `push:main` (or
  `workflow_run` after the sharded run completes) with
  `concurrency: { group: promote-baseline, cancel-in-progress: false }`
  so promotions **queue** and each runs to completion.
- Make the promote job **idempotent + latest-wins**: always promote for
  the newest `main` SHA whose sharded report exists, so a queued backlog
  collapses to one correct promotion.
- Guard-side safety net: if the floor SHA is an ancestor of `main` but
  not equal, treat the standalone delta as **informational** (don't hard
  block) until the floor catches up — prevents a stale floor from
  blocking the whole queue. (Weaker; prefer fixing promotion.)

## Interim mitigation (in use, keep as standing recovery lever)

Manually force-promote the floor to current main via workflow_dispatch
(its concurrency group is separate from push:main, so it runs to
completion):

```bash
gh workflow run test262-sharded.yml -R loopdive/js2 --ref main \
  -f force_baseline_refresh=true -f confirm_force=YES
```

Then have authors `gh run rerun --failed <run>` their standalone-guard
PRs (no code change needed) and enqueue. This is a band-aid — it must be
repeated every time a standalone-shifting change lands and the auto
promotion is cancelled. #2178 is to make it unnecessary.
