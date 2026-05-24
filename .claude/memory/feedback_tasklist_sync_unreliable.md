---
name: Dispatch model — native TaskList auto-dispatch is canonical (manual SendMessage is break-glass)
description: As of 2026-05-23 the team uses Claude Code's NATIVE agent-teams auto-dispatch as the dispatch model. The TaskList is the single source of truth; the tech lead's job is to keep it reconciled, not to route work manually. Manual SendMessage dispatch + owner-pinning is now a break-glass fallback only, used if per-agent TaskList sync visibly breaks.
metadata:
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
## Decision (2026-05-23, user-directed)

Switched from the hand-rolled manual-dispatch model to **Claude Code's native agent-teams auto-dispatch**. Reason: running both layers at once (tech-lead manually pinning owners + the native auto-dispatcher routing) was causing collisions — the dispatcher kept offering already-merged, wrong-role, or already-owned tasks because the two layers had divergent state. The user's call: stop fighting the native system; lean into it.

## The model now

- **The TaskList is the single source of truth.** Not issue files, not SendMessage. Issue files hold the spec/acceptance; the TaskList holds dispatch state.
- **Tech lead's job is RECONCILIATION, not routing.** Keep the canonical TaskList accurate so the native dispatcher routes correctly:
  - Mark a task `completed` the moment its PR merges (stale `in_progress`/`pending` entries are what cause mis-routes).
  - Create tasks with enough description that a dev can work them cold.
  - Let the native auto-dispatcher hand tasks to idle devs; don't pre-route via SendMessage.
- **Devs self-claim** the lowest-ID unowned/unblocked task (their developer.md already says this) and accept auto-dispatched work.
- **Owner is set on claim** (by the dev or the dispatcher), which stops re-offering.

## Why the dispatcher mis-routed before (root cause)

The mis-routes were a STALE CANONICAL LIST, not (only) per-agent view desync: tasks for merged work (#1553c, #1116b, #1587) were left `in_progress`/`pending`, so the dispatcher still saw them as available. Fix = reconcile promptly. The tech-lead-side `TaskList` is authoritative and accurate; keep it that way and native dispatch works.

## Break-glass fallback (the OLD default, now exceptional)

If per-agent TaskList sync visibly breaks again — a dev reports task IDs outside the known range, "TaskList doesn't show X," or treats real assignments as "self-echoes" — THEN fall back to SendMessage as authoritative dispatch for that dev: send the full assignment (issue #, file path, workflow) and set owner+status from the tech-lead side. This is the documented 2026-04-11 failure mode (dev-1036/dev-1038/dev-990 saw disconnected task namespaces). Treat it as an exception, not the default. Don't debug the harness sync mid-session — fall back, continue, investigate after.

## Tech-lead discipline checklist under native model
1. PR merges → immediately `TaskUpdate status=completed`.
2. New work discovered → `TaskCreate` with a self-contained description.
3. Don't manually pin owners as routine (let dispatch/dev-claim do it); only intervene if a collision is observed.
4. Watch for the break-glass signal; if seen, switch that dev to SendMessage.

See also [[feedback_dev_self_serve_tasklist]] (aligned), [[feedback_sendmessage_discipline]].
