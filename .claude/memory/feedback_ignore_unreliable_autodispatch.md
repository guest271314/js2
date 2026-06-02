---
name: feedback-ignore-unreliable-autodispatch
description: "SUPERSEDED 2026-05-23: team switched TO native auto-dispatch. Devs now trust auto-dispatch but sanity-check live state (already-merged? already-owned? right role?) before claiming. Wholesale ignoring of auto-dispatch is break-glass only."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

**SUPERSEDED 2026-05-23.** The user directed a switch TO Claude Code's native
agent-teams auto-dispatch as the canonical dispatch model (see
[[feedback_tasklist_sync_unreliable]] for the full decision). The earlier "ignore
the auto-dispatcher" rule below was the manual-model stance and is now
**break-glass only**.

## Current rule (native model)

Devs **trust auto-dispatch** and claim what it hands them — BUT do a cheap
live-state sanity check first, because the dispatcher can lag the canonical list:
- Is there already a merged/open PR for this issue? → skip, tell tech lead.
- Does another agent already own it (agent-status file / worktree)? → skip.
- Is it actually a dev-implementation task (not architect/PO/spec)? → if not, skip.

If the check passes, claim it (set owner) and work it. The tech lead's job is to
keep the canonical TaskList reconciled (mark merged tasks `completed` immediately)
so these checks rarely trip. Only if sync visibly breaks for a dev (sees task IDs
outside the known range, "TaskList doesn't show X") does the team fall back to
SendMessage direct dispatch for that dev — the documented break-glass path.

## Original observation (the why, retained)

The mis-routes that motivated the manual stance: in one session the dispatcher
handed dev-1116 a duplicate in-flight issue (#1588), an architect-role task
(#126/#1130), and an already-merged issue (#64/#1553c). Root cause was a STALE
CANONICAL LIST (merged tasks left `in_progress`/`pending`), not the dispatcher
being inherently untrustworthy. The fix is prompt reconciliation, which is now
the tech-lead discipline under the native model — not suppressing auto-dispatch.
