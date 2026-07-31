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

**Six PRs** needed a manual `enqueuePullRequest` in one session — #3859, #3864,
#3865, #3866, #3868, #3869 — all with every required check green, all `UNSTABLE` on
`release-pending` alone.

**The control: #3867 reached `CLEAN` and self-enqueued normally.** That is what
proves the enqueue path itself is healthy and this one helper is the entire problem.
Do not inflate the merged count when citing this — the control is the argument.

## Why this is `critical` despite being cosmetic-looking

`release-pending` is **not** in the required-checks list (`docs/ci-policy.md` §7), so
it is correctly not gating merge on the merits. But it gates merge *in practice*, via
`mergeStateStatus`, for **every PR this team opens**. That is a standing tax on all
throughput, not a one-off — and it is invisible, because the PR looks green.

## ROOT CAUSE — pinned to the line, with its own counterexample in the same file

`scripts/retarget-stacked-pr-children.mjs:495`, in `releasePendingAfterSynchronize`:

```js
if (repoFullName(pr.head) !== expected.repo || sha(pr.head) !== expected.headSha) {
  throw new Error(`#${expected.number}: synchronized pull request head changed`);
```

`expected.repo` is `GH_REPO` = `loopdive/js2`. For **any** fork-head PR,
`pr.head.repo.full_name` is `ttraenkler/js2`, so the **first disjunct is always
true** — it throws regardless of the sha, which matched fine.

**The error message is actively misleading**: it reports "head changed" when what
actually happened is "head repo is a fork". That is why this read as a mysterious
per-PR fault for weeks rather than a systematic one.

Verified identical on **#3868** (job 91053206478) and **#3871** (run 30600487933):
`retarget-stacked-pr-children: #N: synchronized pull request head changed` → exit 1.

### The clincher — its own sibling already handles this correctly

`retargetImmediateChildren` at **line 305** treats the identical condition as a
**benign no-op**: *"head repository ttraenkler/js2 is not loopdive/js2; no children"*,
conclusion **success**. That is the `retarget` job that passed on #3863.

**Two functions in one file, same check, opposite verdicts.**

## Fix

**Make line 495 match line 305's treatment — a fork head is a no-op, not an error.**
A few lines, and it removes the manual-enqueue tax from every PR this team opens.

Alternative if that is somehow unsafe: mark the job `continue-on-error: true` so a
non-required check cannot drive `mergeStateStatus`.

**Not recommended:** teaching `auto-enqueue` to accept `UNSTABLE`-with-all-required-green.
That weakens the enqueue gate globally to work around one broken helper.

## Acceptance

- A fork-head PR with all required checks green reaches `CLEAN` and is enqueued by
  `auto-enqueue.yml` with no manual intervention.
- `release-pending` either passes or does not run for fork-head PRs.
