---
name: feedback_no_shared_worktree_assignment
description: "Never assign two agents to the same issue branch/worktree — uncommitted changes collide; check branch ownership before reassigning a task"
metadata:
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

Never assign two agents to the SAME issue branch / worktree concurrently.
During sprint 63 the tech lead reassigned task #45 (#2191) onto the
`issue-40-string-residual` branch while sdev-proxy3 was already working
there — both agents ended up editing the same worktree, and sdev-proxy3's
uncommitted fix in `case-convert-native.ts` collided with sdev-json3's
experiments. It resolved only because sdev-json3 noticed the foreign
uncommitted changes and backed off cleanly.

**Why it happens:** task reassignment churn. A task whose fix lives on
branch X gets handed to agent B while agent A still owns branch X's
worktree. Worktrees are per-branch, so two agents on the same branch share
one working tree and clobber each other's uncommitted edits (and the shared
git stash — see [[feedback_no_git_stash_in_worktree]]).

**How to apply:**
1. Before assigning/reassigning a task, check whether its target branch is
   already an active worktree owned by another agent. If so, do NOT assign a
   second agent to it — either let the current owner finish it, or carve a
   genuinely separate slice on a NEW branch for the second agent.
2. One branch = one owner. If a bug turns out to live on another agent's
   branch (e.g. #2191 was actually a bug in #40's branch), hand the WHOLE
   piece to that branch's owner rather than sending a second agent in.
3. Keep each agent in its own `issue-NNN-...` worktree; don't let a
   reassignment pull an agent into a peer's worktree.

**Cross-SESSION dimension (sprint 63, 2026-06-18):** the `js2wasm` team is
shared across MULTIPLE concurrent Claude driver sessions. "Ownership" is
therefore NOT just your own TaskList — another session's agent can hold the
real claim. On #49/#2193 PR-B, another session's `sendev-protomember`
claimed the branch (git lock) at 05:33Z and was building; meanwhile this
session spawned a fresh senior onto the SAME `issue-2193-pr-b` branch — a
third party into a contested worktree. Earlier the same branch had two
orange agents clobber each other (one's `compileArraySliceFromVecLocal`
extraction got reset out from under it). **Before spawning/assigning a
senior onto an EXISTING feature branch, check whether another session
already owns it:** `git ls-remote origin <branch>` exists + an active
worktree/claim (look for `sendev-*`/peer agents referencing it in recent
messages) ⇒ concede to the lock-holder, do NOT spawn a competitor. Rate
limits + collisions are oversubscription signals — CONSOLIDATE (concede +
shut down redundant spawns), don't maintain a private "keep N seniors"
count that double-spawns work another session is already driving.
