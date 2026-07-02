---
id: 2975
title: "auto-enqueue re-adds a just-parked PR before auto-park's hold label lands (~5-16s race) — one doomed merge_group attempt per park"
status: ready
created: 2026-07-02
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

Note #2462's re-add happened 1s *after* the label — the sweep's PR-list
snapshot was taken before the label API write became visible, so even
label-before-add ordering is not a guarantee: the race is between auto-park's
label write and auto-enqueue's *read*.

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
