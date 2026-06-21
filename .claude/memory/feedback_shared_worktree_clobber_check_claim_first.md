---
name: feedback_shared_worktree_clobber_check_claim_first
description: "Before editing a continuation/PR-B branch a teammate may own, check the git claim lock by ISSUE id (not task id) — a co-owner's worktree reset silently reverts your edits"
metadata:
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

When the tech lead assigns you a continuation slice (PR-B/PR-C) on an issue another
agent started, **check the git claim lock by the ISSUE id before touching the
branch/worktree** — `node scripts/claim-issue.mjs <ISSUE-id> <you> --status`. The
TaskList "task id" (#49) is NOT the issue id (#2193); `claim-issue.mjs <task-id>`
matches the wrong/old issue file and lies ("nothing to claim" / "already done").

**Why this bit:** on #2193 PR-B, the lead assigned the task to me twice, but a
dedicated proto-member senior (`sendev-protomember`) already held the #2193 claim and
was working the SAME worktree `issue-2193-pr-b`. I edited + built + tested a clean
`compileArraySliceFromVecLocal` extraction — then their worktree reset silently
**reverted my source AND dist** out from under me mid-flight (git status clean, edit
gone, no reflog reset on my side). Two agents, one worktree = clobber — the exact
[[feedback_no_shared_worktree_assignment]] hazard.

**How to apply:**
1. `claim-issue.mjs <ISSUE-id> --status` FIRST. If held by another agent, do NOT
   `--force`-steal a same-worktree continuation — back off (release, clear task owner,
   flag the lead), same as backing off a `[CONFLICT]` someone else owns.
2. If you legitimately own a continuation, branch your OWN worktree off the shared
   branch's head (`git worktree add … -b <your-branch> <shared-branch-head>`) — never
   write in a worktree a co-owner is live in.
3. A lead re-assigning a task you're told to "go build" does NOT override another
   agent's existing claim lock — the lock wins; reconcile with the lead.
