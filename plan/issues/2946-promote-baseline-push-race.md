---
id: 2946
title: "promote-baseline loses its baselines-repo push race under overlapping main runs (rebase retries can never resolve)"
status: ready
sprint: current
created: 2026-07-02
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: tooling
goal: ci-hardening
related: [2920, 1951, 1668]
---

# #2946 — promote-baseline push race: retries rebase wholesale-regenerated JSONLs and always conflict

## Problem

The `promote merged report to main baseline` job (test262-sharded.yml) pushes
the refreshed baseline files to `loopdive/js2wasm-baselines` with a
fetch→rebase→push retry loop (5 attempts). When **another** main run's promote
lands between this job's checkout and its push, every retry fails identically:
the baseline files (`test262-current.jsonl`, `test262-standalone-current.jsonl`,
the report/summary JSONs) are **wholesale-regenerated every run**, so rebasing
one refresh commit onto another is a guaranteed whole-file content conflict.
The loop exists for a transient race, but this race is not transient — the
loser can never win by retrying a rebase. Result:
`##[error]Failed to push baselines after 5 attempts (persistent, not a
transient race).`

## Evidence (2026-07-02, push:main runs during the #2424 landing window)

Main advanced 4 times in ~22 minutes (00:56, 01:05, 01:12, 01:19 + 01:27);
the shard matrix takes ~15–20 min, so promote jobs overlap heavily:

| Run                 | Main SHA | promote-baseline | Cause                                                                                                   |
| ------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| 28558202948 (#2424) | 9d37728  | **failure**      | lost race; 5/5 rebase attempts conflicted on all 8 baseline files applying its refresh commit `cdd5dd5` |
| 28558439826 (#2444) | dacd7fd  | success          | won its race window; pushed `71d3569` on attempt 1                                                      |
| 28558701658 (#2443) | a14faa4  | **failure**      | same conflict signature, 5/5 attempts                                                                   |

Consequence in that window: the honest post-#2424 re-seed only happened
because the _next_ run (#2444) won — the run that carried the intentional
re-baseline itself never promoted, and #2443's results were never promoted at
all. Under sustained merge-queue throughput roughly **every overlapping run's
promote is a coin flip**, so the rolling baseline skips main states
non-deterministically (staleness the #1668 stale-baseline guard only catches
past its threshold).

## Fix direction

The refresh commit's content is a pure function of the run's merged reports —
history does not need to be merged, only _replaced newest-wins per main
generation_:

1. **Stop rebasing content; regenerate or overwrite instead.** On push
   rejection: `git fetch` + `git reset --hard origin/main` + re-copy this
   run's already-built baseline files + commit + push. Retries then always
   converge (last writer wins the whole file set, which is the correct
   semantic for a wholesale snapshot).
2. **Guard ordering, not content**: before overwriting, compare the _main
   commit generation_ embedded in the baseline commit message (or a
   `baseline_sha` field): if the remote HEAD's source main SHA is a
   **descendant** of this run's main SHA, the remote is newer — skip the push
   and exit 0 (this run's snapshot is obsolete, which is fine). If it is an
   ancestor, overwrite. This makes the race benign in both directions and
   removes the false-failure noise.
3. Optional hardening: GitHub Actions `concurrency` group on the promote job
   (`concurrency: baselines-promote`, `cancel-in-progress: false`) to
   serialize promotes so the race window mostly disappears; keep 1+2 as the
   correctness backstop.

## Acceptance

- Two overlapping push:main runs both finish promote-baseline green; the
  baselines repo ends at the newer run's snapshot.
- An out-of-order finisher (older main SHA finishing last) does NOT clobber a
  newer baseline (ancestor/descendant check) and does NOT fail the job.
- No `Failed to push baselines after 5 attempts` occurrences under normal
  queue throughput.

## Context

Filed from the #2920/#2424 revert verification (task #2, dev-2912f): the
re-seed-before-revert ordering requirement was only satisfied by the _next_
run's promote winning its race. See the "Revert record" section in
`plan/issues/2920-strict-negative-verdict-succeeded-arm.md`.
