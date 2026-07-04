---
id: 2786
title: "Auto-enqueue: make the server-side workflow_run path the single primary; drop the per-agent enqueue and the grace window"
status: done
sprint: 69
created: 2026-06-28
completed: 2026-06-28
priority: high
horizon: s
feasibility: medium
task_type: infra
area: ci
goal: merge-pipeline-reliability
---

# #2786 — Server-side auto-enqueue is the single primary; drop the per-agent enqueue + grace

## Problem

Green PRs were stranding un-enqueued (observed on #2225 and #2247 — the merge
queue sat empty while a CLEAN, all-checks-green PR was never added). Root cause
is a **design coupling**, not a missing mechanism:

- The fast "primary" enqueuer was a **per-agent one-shot enqueue**: when a dev's
  PR went green, the dev (or its backgrounded CI watcher) enqueued it. That
  watcher is a **child of the agent process** — it **dies when the agent parks/
  terminates** on stand-down. So a green PR whose dev had already stood down
  stranded with nothing to enqueue it.
- The server-side `auto-enqueue.yml` workflow exists and has a responsive
  `workflow_run`-on-completion trigger, BUT its script had `GRACE_MINUTES = 10`
  ("only enqueue a PR green for ≥ 10 min, so it never races a fresh dev
  enqueue"). At CI-completion the PR's green-duration ≈ 0 < 10, so the
  **responsive trigger SKIPPED every just-green PR** — the only thing that
  eventually caught a failed-dev-watcher strand was the **~30-min cron**. Strand
  window: up to ~30 min.

So the grace window (added to avoid racing the dev) *defeated* the responsive
path exactly when the dev path failed.

## Fix

Make the server-side `workflow_run` path the **single primary** enqueuer — the
one actor that is long-lived and outside agent lifecycle:

1. **`scripts/enqueue-green-prs.mjs`**: `GRACE_MINUTES` default `10 → 0`. With no
   dev enqueue to race, the responsive `workflow_run` run (which starts ~60s
   after checks finish — enough for GitHub to settle `mergeStateStatus` to
   `CLEAN`) enqueues every just-green PR immediately.
2. **`.github/workflows/auto-enqueue.yml`**: documented as PRIMARY (not backstop).
   The `workflow_run.workflows: ["Test262 Sharded", "CI"]` list already covers
   every required check — `cheap gate` + `merge shard reports` (Test262 Sharded)
   and `quality` (CI).
3. **Drop the per-agent enqueue** across the operative docs — devs/senior-devs
   now run `/dev-self-merge`, and on MERGE **mark the task completed + stand
   down**; they do NOT touch the merge queue. Updated: `.claude/skills/dev-self-merge.md`,
   `.claude/agents/developer.md`, `.claude/agents/senior-developer.md`, `CLAUDE.md`
   (dev-loop block, merge-protocol step 5, shepherd/lead-sweep framing).
4. **Backstops kept** (not the mechanism): the workflow's ~30-min cron and the
   tech-lead/shepherd per-loop open-PR sweep catch the rare stray the responsive
   run misses (e.g. a PR the queue dropped on main-advance).

Security unchanged & now load-bearing: the workflow's author-trust gate
(OWNER/MEMBER/COLLABORATOR only) + `cla-check` remain the external-PR guard.

## Why not "the lead does it instead"

The lead/shepherd sweep has the same weakness in a different form — it runs only
on the lead's loop cadence (latency) and is itself a killable agent. The robust
primary is the GitHub Actions workflow: event-driven, lifecycle-independent.
Lead/shepherd sweep stays a backstop.

## Validation

Broad infra change (touches the queue machinery — the comments note it wedged the
serial queue twice historically when a forming head was poked). The
`trailing-add only` guard (#2560) is preserved — the sweep never touches the
forming head. Validate full CI; confirm `node --check` on the script and that the
grace-0 path still respects all-checks-green + author-trust + hold-label guards.

## Acceptance

- A just-green CLEAN trusted-author PR is enqueued by the `workflow_run` run
  within ~one workflow-startup of CI completion, with no agent enqueue.
- No dev/agent ever issues `enqueuePullRequest`; docs are internally consistent.
- `hold`/draft/external-author PRs still skipped; no re-enqueue loop path exists.
