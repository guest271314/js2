---
name: reference-stale-isolation-binding-cross-worktree-write
description: "bg-isolation guard binding can go stale across day-rollover/resume and redirect an agent's writes into ANOTHER agent's active worktree"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

Observed 2026-07-02 (dev-2912f): after a day-rollover + multiple session-limit resumes, the background-isolation guard's Edit/Write binding pointed at a DIFFERENT agent's active worktree (dev-2937f's, with its branch checked out). Following the guard's redirection would have silently committed onto the other agent's branch.

**Why:** the guard pins Write/Edit to the worktree assigned at spawn; after rotations/renames/rollover the binding can reference a path since reassigned to another live agent.

**How to apply:** every agent, on its FIRST write after any resume (window reset, error resume, day rollover), must verify identity first: `pwd` + `git -C <target> branch --show-current` and confirm the branch is ITS OWN before editing. If the guard redirects to a foreign worktree: do not follow it — write via Bash in your own worktree and flag the lead. Leads: when rotating agents, be aware old worktree paths may be re-bound. Related: [[feedback_dev_agents_worktree]], [[feedback_shared_worktree_clobber_check_claim_first]].
