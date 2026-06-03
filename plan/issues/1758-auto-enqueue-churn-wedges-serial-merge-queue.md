---
id: 1758
title: "auto-enqueue churn wedges the serial merge queue — make the sweep surgical"
status: done
created: 2026-05-31
updated: 2026-05-31
completed: 2026-05-31
priority: high
feasibility: medium
task_type: bugfix
area: ci-infra
goal: platform
sprint: Backlog
related: [1756]
---
# #1758 — auto-enqueue churn wedges the serial merge queue

## Symptom

The merge queue wedged **twice in one day** (2026-05-30 ~11:15 → recovered, then
re-wedged overnight; 5 PRs — #985/#988/#984/#983/#987 — piled up `AWAITING_CHECKS`
/ `QUEUED` with **zero `merge_group` runs dispatched** since 11:15). Ordinary PR
CI (`pull_request`/`push`/`schedule`) kept running fine throughout, and
githubstatus.com showed no incident — so it is a GitHub-side queue-processor
wedge, not our config and not a global Actions throttle.

Diagnosis that pinned the trigger (2026-05-31): dequeuing the stuck head
promoted a *fresh, fully-green* PR to the head, which **also** stalled in
`AWAITING_CHECKS` with no `merge_group` — even after auto-enqueue was disabled
and the PR was cleanly re-enqueued. So a clean enqueue could not unstick it; the
~10-min ruleset disable/re-enable reset was required (see
[feedback_wedged_merge_queue_reset]).

## Root cause / why auto-enqueue is implicated

`.github/workflows/auto-enqueue.yml` (`scripts/enqueue-green-prs.mjs`) runs
**on every CI completion + every 10 min** and enqueues *every* open, non-draft,
mergeable, not-already-queued PR. Against a **serial** merge queue
(`max_entries_to_build=1`), this is an unconditional, high-frequency poke at the
queue. Around the wedge it fired **3x in 10 min** (23:42, 23:49, 23:52) right as
the head was being enqueued at 23:50. A dequeue/enqueue race against the serial
head **during `merge_group` formation** is a known way to wedge GitHub's queue,
and the timestamps line up exactly. The mechanism built to *un-strand* PRs is
now the thing that *wedges* the queue and strands everything — and it cannot fix
what it caused.

## Why the original justification has largely eroded

auto-enqueue was added 2026-05-29 as a backstop for two stranding modes:

1. **The `gh pr merge --auto` no-op trap** — `--auto` only arms on a
   *check-state transition*, so on an already-green (`CLEAN`) PR it silently
   no-ops and the PR never queues. Stranded a 9-PR backlog with an empty queue.
2. **Queue-drop on main advance** — the serial queue drops a PR that goes
   "behind"; nobody re-enqueues -> strand.

Mode #1 is now **fixed at the source**: devs enqueue via the GraphQL
`enqueuePullRequest` mutation (no transition dependency, enqueues
unconditionally). So the backstop's only remaining real job is mode #2 + devs
that exit before enqueuing — both rare. Its aggressive cadence is no longer
justified and is now net-negative.

## Proposed fix (make the sweep surgical, don't delete it)

Keep the strand-recovery safety net, remove the churn that triggers the wedge:

1. **Grace window** — only enqueue a PR that has been **green-but-unqueued for
   > N minutes** (e.g. 10). This guarantees the backstop never races a fresh
   dev GraphQL enqueue; it only catches genuine strays. Derive "green since"
   from the latest required check-suite completion time.
2. **Back off while the queue head is forming** — if any queue entry is in
   `AWAITING_CHECKS` (a merge group is mid-formation), **skip the sweep this
   cycle** and let GitHub finish. Only sweep when the queue is idle/stable or
   empty.
3. **Lower the cadence** — drop the cron from every 10 min to every ~30 min (the
   on-CI-completion trigger already covers the responsive case); combined with
   (1)+(2) this removes the high-frequency serial-queue poking.
4. (optional) **Single-flight** — concurrency group so two sweeps never overlap.

## Acceptance

- `scripts/enqueue-green-prs.mjs` skips PRs green for less than the grace window
  and skips the entire sweep when any entry is `AWAITING_CHECKS`.
- Cron cadence reduced; concurrency-guarded.
- A green-but-stranded PR (no entry, green > grace window) is still picked up
  within one cycle — the safety net is preserved.
- Document the interaction with the serial queue in the workflow file header.

## Notes

- Interim operational fix when wedged: the ~10-min ruleset disable/re-enable
  reset (NOT a quick toggle) — [feedback_wedged_merge_queue_reset].
- If wedges keep recurring after this lands, open a GitHub Support ticket
  (merge queue not dispatching `merge_group` despite clean config / no incident).
- auto-enqueue was **temporarily disabled** during the 2026-05-31 reset; re-enable
  it once this surgical version (or at least the back-off guard) is in place.
