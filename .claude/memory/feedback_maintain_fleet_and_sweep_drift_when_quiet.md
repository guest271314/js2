---
name: feedback_maintain_fleet_and_sweep_drift_when_quiet
description: "Going 'quiet' to the user must NOT mean passive on orchestration. Keep backfilling the fleet on per-agent stand-downs (right-size vs budget, not vibes) AND periodically sweep mergeStateStatus — CI watchers poll checks, not mergeability, so drift-induced DIRTY/BEHIND strands PRs silently."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

**The lapse (2026-07-10):** while "holding for the flip," the lead let the
active fleet thin to ~2 agents and finished PRs stranded DIRTY unnoticed —
while **86% of the weekly budget remained** (agents stood down at their own
per-agent CONTEXT limits, 250–735k tokens each, NOT a budget limit) and a deep
claimable pool sat idle. Even the flip PREREQUISITE (#2833) sat DIRTY.

**Root causes:**
1. **Tunnel vision on one signal.** Fixating on "hold for the flip go/no-go"
   → stopped tending the broader fleet + queue.
2. **Stand-down treated as a completion, not a backfill trigger.** Each agent
   hitting its context limit silently shrank the fleet; no replacement spawned.
3. **Relied on completion notifications to reveal state — but drift is SILENT.**
   A dev's CI watcher polls `gh pr checks` (CI status), NOT mergeability. So a PR
   going DIRTY/BEHIND from main advancing is invisible to the watcher — the dev
   waits on a CI signal that never comes while the PR rots. Only a proactive
   `mergeStateStatus` check surfaced it.

**Corrections (how to apply — every orchestration cycle, even while "quiet"):**
1. **Quiet to the USER ≠ passive on orchestration.** "Surface only
   decision-grade signals" is a *communication* choice; keep the
   sweep+backfill maintenance loop running in the background regardless.
2. **Backfill on stand-down.** A stand-down (context exhaustion) shrinks the
   fleet — immediately spawn a fresh replacement if budget + claimable pool
   remain. Maintain the target size; don't let "agent finished" quietly shrink it.
3. **Right-size against `node scripts/budget-status.mjs`, not the impression of
   a wind-down.** Agents standing down ≠ budget spent. If remaining budget >>
   utilization (e.g. 86% budget with 2 active agents → per-agent share 43%,
   "phase: fresh → big rocks"), scale UP.
4. **Periodically sweep `mergeStateStatus` on open PRs.** DIRTY/BEHIND on an
   inactive-author PR = a silent strand → re-merge origin/main (baseline/LOC/
   coercion files drift constantly → regenerate) or file a `[CI-FIX]`.
5. **Keep a standing PR-queue shepherd staffed during active merge churn**
   ([[feedback_dedicated_pr_shepherd]], [[feedback_lead_shepherds_prs]]) — with
   a thin fleet, PRs drift DIRTY faster than owners can re-merge them.
6. **A stale PR `updatedAt` ≠ an idle dev.** The owner may be working LOCALLY
   (uncommitted/unpushed in its worktree — invisible to the sweep, which only
   sees the pushed PR state). Before directing another agent to take over an
   OWNED branch, PING the owner and WAIT for a reply — do NOT parallel-dispatch
   "take it" + "are you alive" (that races the takeover into a worktree-clobber:
   2026-07-10 it discarded a still-active dev's uncommitted loc-baseline). Only
   an unowned/confirmed-stood-down PR is safe to reassign immediately.
7. **Check labels before enqueuing a "CLEAN" stray.** CLEAN mergeability does
   NOT mean admittable — a `hold`/`do-not-merge`/`wip` label (or a bot
   park-hold) still blocks it. Read `.labels` before telling the shepherd to
   enqueue (2026-07-10: mis-flagged a held #3040 PR as an enqueue candidate).
