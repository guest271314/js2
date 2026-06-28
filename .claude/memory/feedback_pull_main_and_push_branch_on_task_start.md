---
name: feedback_pull_main_and_push_branch_on_task_start
description: "Pull latest origin/main before starting a task; push the branch to origin the moment it goes in-progress, so it's a live sync point for other agents"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 12c43077-c2b6-4d65-be90-38a24eecc6a6
---

When an agent **claims a task / moves it to in-progress**, the protocol is:
1. **Pull/merge latest `origin/main`** into the worktree branch FIRST (branch from
   current `origin/main`, post-fetch — never a stale base).
2. **Push that branch to origin IMMEDIATELY** (an initial/WIP/grounding commit is
   fine) the moment the task goes in-progress — do NOT work local-only for a long
   window before the first push.
3. Keep merging `origin/main` as work proceeds.

**Why:** an agent working locally for a long time before its first push leaves the
branch invisible — other agents can't see the in-progress work, so staleness and
collisions hide until the PR finally appears (this session, sd-s3a worked ~30 min
on S3a before its PR surfaced). Pushing early makes the branch a **live sync
point**: other agents see it, the assignment is concrete, and rebases happen
against real visible state.

**How to apply:** include in every dispatch prompt; encode in the CLAUDE.md dev
loop + pre-commit/claim checklists + the developer/senior-developer agent defs.
Pairs with branching from `origin/main` ([[feedback_branch_from_upstream_main_not_fork]])
and the no-stale-fork rules. Canonical doc home = CLAUDE.md "Merge protocol";
land doc changes as a PR off current `origin/main`, not from the stale `/workspace`.
