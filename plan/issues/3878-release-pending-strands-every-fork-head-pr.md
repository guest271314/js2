---
id: 3878
title: "`release-pending` fails on EVERY fork-head PR, making every team PR strand un-enqueued"
status: ready
created: 2026-07-31
priority: critical
feasibility: easy
horizon: s
task_type: bugfix
area: ci
goal: ci-hardening
sprint: current
related: [2786, 3800]
---

# #3878 — a non-required check silently blocks every PR this team opens

## The mechanism (two correct behaviours composing into a stall)

1. **`release-pending`** (`.github/workflows/passive-stack-retarget.yml`) fails at
   `releasePendingAfterSynchronize` (`scripts/retarget-stacked-pr-children.mjs:495`)
   on `repoFullName(pr.head) !== expected.repo` — head is `ttraenkler/js2`, expected
   is `loopdive/js2`. **That condition is true for every fork-head PR**, and this
   team pushes branches to the fork by policy (see CLAUDE.md merge protocol).
2. A red check — even a **non-required** one — drives `mergeStateStatus` to
   **`UNSTABLE`** rather than `CLEAN`.
3. `auto-enqueue.yml` enqueues only `ENQUEUEABLE = new Set(["CLEAN", "HAS_HOOKS"])`
   (`scripts/enqueue-green-prs.mjs:114`). **`UNSTABLE` is deliberately excluded.**

**Net: a PR with all 7 required checks green and one informational check red is
never picked up by any automation — including the ~30-minute cron, which applies
the same filter.** It strands until a human or shepherd manually enqueues it.

## Measured, 2026-07-31

Four PRs stranded in exactly this state — **#3859, #3864, #3865, #3866** — all with
every required check green, all `UNSTABLE` on `release-pending` alone. Each needed
exactly one manual `enqueuePullRequest` with the user PAT. A fifth, #3867, reached
`CLEAN` and **self-enqueued normally**, confirming the enqueue path itself is
healthy.

## Why this is `critical` despite being cosmetic-looking

`release-pending` is **not** in the required-checks list (`docs/ci-policy.md` §7), so
it is correctly not gating merge on the merits. But it gates merge *in practice*, via
`mergeStateStatus`, for **every PR this team opens**. That is a standing tax on all
throughput, not a one-off — and it is invisible, because the PR looks green.

## Fix (either is sufficient; the first is better)

1. **Fix the helper** so it does not fail on fork-head PRs — the condition it is
   testing is not a defect for a fork-head PR, it is the normal case here.
2. **Mark the job `continue-on-error: true`** so a non-required check cannot drive
   `mergeStateStatus`.

A third option — teaching `auto-enqueue` to accept `UNSTABLE`-with-all-required-green
— is **not** recommended: it would weaken the enqueue gate globally to work around
one broken helper.

## Acceptance

- A fork-head PR with all required checks green reaches `CLEAN` and is enqueued by
  `auto-enqueue.yml` with no manual intervention.
- `release-pending` either passes or does not run for fork-head PRs.
