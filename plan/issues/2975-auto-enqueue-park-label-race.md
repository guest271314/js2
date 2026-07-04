---
id: 2975
title: "auto-enqueue re-adds a just-parked PR before auto-park's hold label lands (~5-16s race) — one doomed merge_group attempt per park"
status: done
assignee: ttraenkler/agent-opus-2109
created: 2026-07-02
updated: 2026-07-03
completed: 2026-07-03
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: tooling
goal: developer-experience
sprint: Backlog
related: [2547, 2786]
---

# #2975 — auto-enqueue vs auto-park label race re-admits just-parked PRs

## Problem

`auto-enqueue.yml` (`scripts/enqueue-green-prs.mjs`, primary enqueuer since
#2786, grace 0) and `auto-park` (#2547) both react to the same
`workflow_run`-completion signal of a failed `merge_group` run. When a PR
fails its merge_group re-validation, GitHub's merge queue removes it, and the
two workflows race:

- **auto-park** posts the `auto-park-bot:merge-group-failure` comment and adds
  the `hold` label;
- **auto-enqueue** sweeps, still sees the PR as CLEAN + green + **not yet
  `hold`-labelled**, and re-adds it to the queue.

When auto-enqueue wins the race, the just-parked PR gets **one extra doomed
merge_group attempt**: a full 57-shard Test262 run is wasted, the queue is
occupied for the duration, and the group rebuild can reshuffle/cancel entries
behind it (membership change — see
`project_merge_queue_requeue_cancels_run`). The extra attempt fails the same
way, and only then does the (already-applied) hold stop the cycle.

## Evidence (two independent occurrences, 2026-07-02)

PR #2462 (event timeline, `issues/2462/events`):

```
04:19:36Z removed_from_merge_queue by github-merge-queue[bot]   (failure 1)
04:19:44Z labeled hold             by github-actions[bot]       (auto-park)
04:19:45Z added_to_merge_queue     by js2-merge-queue-bot[bot]  (re-add 1s AFTER label, 9s after removal)
04:25:15Z removed_from_merge_queue by github-merge-queue[bot]   (doomed attempt fails identically)
```

PR #2481:

```
08:50:12Z removed_from_merge_queue by github-merge-queue[bot]   (failure 1)
08:50:28Z added_to_merge_queue     by js2-merge-queue-bot[bot]  (re-add BEFORE the label)
08:50:33Z labeled hold             by github-actions[bot]       (auto-park lands 5s too late)
09:02:42Z removed_from_merge_queue by github-merge-queue[bot]   (doomed attempt fails identically)
```

Note #2462's re-add happened 1s _after_ the label — the sweep's PR-list
snapshot was taken before the label API write became visible, so even
label-before-add ordering is not a guarantee: the race is between auto-park's
label write and auto-enqueue's _read_.

## Fix directions (pick one; (a) is self-contained)

- **(a) Failure-aware sweep (preferred)**: in `enqueue-green-prs.mjs`, before
  enqueueing a PR, check its most recent `merge_group` workflow run for the
  current head SHA; if that run concluded `failure` and no human
  `unlabeled`-hold event exists after the run's completion, skip the PR (it is
  being parked or deserves to be). This is race-free because it derives the
  park decision from the same source auto-park uses instead of from the label.
- **(b) Order the workflows**: make the auto-enqueue sweep triggered by a
  failed `merge_group` run wait for the auto-park workflow run of the same
  triggering event to complete before sweeping (gh run watch / poll).
- **(c) Removal-debounce**: skip any PR whose `removed_from_merge_queue` event
  is younger than N minutes (N≈5) unless a human hold-removal is younger
  still. Blunt but simple; N must stay below the human re-admit latency.

## Acceptance criteria

- [ ] A PR whose merge_group run fails is NOT re-added to the queue by the
      auto-enqueue sweep in the window before the auto-park label lands
      (verify by timeline on the next natural park: no
      `added_to_merge_queue` between `removed_from_merge_queue` and
      `labeled hold`).
- [ ] A human/agent removing the `hold` label still gets exactly one prompt
      re-admission on the next sweep (the fix must not dead-lock legitimate
      re-admissions).
- [ ] No new re-enqueue loops (single trailing add preserved — #2786
      invariant).

## Resolution (2026-07-03)

Implemented **direction (a) — the race-free failure-aware sweep** — in
`scripts/enqueue-green-prs.mjs`, plus a regression test
(`tests/issue-2975-park-race-guard.test.ts`).

**Mechanism.** Once per sweep, `recentMergeGroupFailures()` builds a
`Map<prNumber, failedAtMs>` of PRs with a **genuine, recent** `merge_group`
failure by reading the same signal auto-park reads (the failed run, not the
label):

- Lists `merge_group` runs via the REST API (`gh api
repos/<repo>/actions/runs?event=merge_group`) — NOT `gh run list
--event/--status`, whose CLI flags don't exist in gh 2.23; the REST params
  work across every gh version and let this be validated locally.
- Parses the PR number from the run's `gh-readonly-queue/main/pr-<N>-<sha>`
  head branch (`prNumberFromMergeQueueBranch`, mirroring auto-park's
  `prNumberFromQueueBranch`).
- Applies auto-park's **real-vs-cancellation** guard: a run-level failure can
  be a mere cancellation (a re-grouped queue cancels in-flight runs — 0 failed
  jobs), so it requires **≥ 1 job** with conclusion `failure`
  (`runHasFailedJob`, via the REST jobs endpoint).
- Bounds staleness to a 30-min window.

In the per-PR loop, right after the `ENQUEUEABLE` (CLEAN) check, a PR in that
map is **skipped** unless a `hold` label was removed _after_ the failure
(`holdLabelRemovedAtMs` reads the PR timeline; `shouldSkipParkingRace` is the
pure decision) — a later removal is a deliberate re-admission and must be
honoured.

**Fail-safe by construction.** Every live helper returns the value that makes
the sweep fall back to **current (enqueue) behavior** on any error
(`recentMergeGroupFailures` → empty map; `runHasFailedJob` → false;
`holdLabelRemovedAtMs` → +∞ ⇒ "re-admitted"). So a bug or API hiccup can only
ever _fail to skip_ (= today's behavior, which auto-park still catches) — it can
**never** wrongly strand a good PR. This neutralises the blast-radius risk of
editing the primary enqueuer.

**Validation.** `node --check`; import-purity (no `gh` call on import); the
three REST queries validated against the real park of **#2517** (branch →
2517; 1 failed job; timeline hold-removal 08:13:47Z < re-failure 08:22:48Z ⇒
correctly re-skipped); a full `DRY_RUN=1` sweep runs clean; 7-case unit test
passes. (Issue tests aren't in required CI — #3008 — but the pure logic is
covered and the live path is fail-safe.)

Acceptance status:

- [x] A failed PR is not re-added in the pre-label window (guard skips on the
      failed-run signal, before auto-park's label lands).
- [x] A human removing `hold` after the failure gets its one re-admission
      (`shouldSkipParkingRace` returns false when `holdRemovedAtMs >
    mergeGroupFailedAtMs`).
- [x] No new re-enqueue loops — the guard only ever ADDS skips; the
      trailing-add invariant (#2786/#2560) is untouched.
