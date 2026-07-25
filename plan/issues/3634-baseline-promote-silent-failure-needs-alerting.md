---
id: 3634
title: "Baseline-promote can fail silently for hours, degrading every PR's regression gate — needs alerting + retry"
status: ready
created: 2026-07-25
priority: high
horizon: m
feasibility: medium
area: ci
goal: ci-hardening
related: [3467, 3468, 2562, 1235, 2547]
---

# #3634 — baseline-promote fails silently; every PR's regression gate degrades

## What happened (measured, 2026-07-24/25)

The job **"promote root baseline + cache per-SHA for queue merge (#3467/#3468)"**, step
*"Promote root baseline + per-SHA cache to baselines repo"*, **failed on SIX CONSECUTIVE
push-to-main runs** over ~2h45m:

| run | time | merge |
|---|---|---|
| 30130790253 | 22:23Z | #3574 |
| 30134053780 | 23:32Z | #3581 |
| 30134654044 | 23:46Z | #3580 |
| 30135274700 | 00:01Z | #3586 |
| 30137169278 | 00:49Z | #3563 |
| 30137847398 | 01:07Z | #3589 |

It then self-recovered from 01:41Z onward.

## Why it matters far beyond one job

Every failed promote leaves the baselines-repo reference un-refreshed, so **each subsequent
PR's regression gate diffs against an ever-staler baseline**. Observed on PR #3583:
`SRC_BEHIND` climbed **3 → 8** in ~70 minutes with `CONTENT_CURRENT="false"` on both runs.

#3583 was then **parked twice** on 26 then 32 "regressions" that were entirely Temporal
`skip → compile_error` rows with **zero non-Temporal regressions** — transitions it did not
cause. It merged unaided at 01:41Z once the promote recovered. **No code change was ever
needed.** Three separate manual investigations that day traced back to this single cause.

## The actual defect: nothing alerts

The push-to-main runs show as `failure` in the Actions list and **nobody watches them** —
the team watches PR checks. A silent multi-hour outage of the baseline publisher degrades
the regression gate for *every open PR* and surfaces as unrelated PRs mysteriously parking.
That misdirection is the expensive part, not the outage itself.

## Fix, in order of value

1. **ALERT on a failed baseline-promote.** This is the big one; the failure is currently
   invisible and its blast radius is every open PR.
2. **RETRY the promote step.** Six sequential merges each pushing to the baselines repo
   smells like a push race — a retry-with-rebase would likely have absorbed all six.
   Confirm against the six job logs before assuming.
3. **Consider making the regression gate REFUSE TO VERDICT when `SRC_BEHIND` exceeds a
   threshold**, rather than confidently diffing against a known-stale baseline and emitting
   false regressions. A gate that says *"baseline too stale to judge"* is far cheaper than a
   spurious park plus the investigation it triggers.

## Discarded hypothesis — do not chase it

The `github.actor != 'github-actions[bot]'` guard on *"promote merged report to main
baseline"* is **NOT** the problem: the actor is `github-merge-queue[bot]`, which passes that
clause. That job legitimately skips on push because the shard matrix has been
merge_group-only since the #2519 slim-down.

## Documentation bug found alongside

CLAUDE.md states `test262-current.json` is *"refreshed by the promote-baseline job (every
push to main)"*. Observed behaviour differs: **"promote merged report to main baseline" is
SKIPPED on push**; the job that actually publishes is **"promote root baseline + cache
per-SHA"**. Anyone diagnosing this from the docs looks at the wrong job first — I did.
