---
name: feedback_architect_subagent_commit_output
description: Architect/one-shot subagents run with isolation:worktree — their written docs are LOST on shutdown unless committed+merged or written to a captured path
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd85f78e-e46f-4c52-b752-d9a8f971f948
---

Spawned an architect subagent (arch-s6) with isolation:worktree to write the #1888 S6 implementation spec into plan/issues/1888-openany-dispatch.md. It reported "done", I read the spec, then shut it down. Later a dev couldn't find the spec: it existed only in arch-s6's isolated worktree, which auto-cleaned on shutdown — never committed/merged to main. The ~4.6k-lever spec was lost; had to reconstruct the load-bearing design from what I'd read into the conversation and relay it inline to the implementing dev.

**Why:** `isolation: worktree` subagents write to an ephemeral git worktree. When the subagent terminates (or is shut down), the worktree is removed and any uncommitted/unmerged work vanishes. The architect's "I wrote the doc" is true *in its worktree* — not on main.

**How to apply:**
- A subagent's deliverable only survives if it is COMMITTED + the branch/worktree is captured (PR opened, or the file merged) BEFORE the agent exits. For isolation:worktree writers, require "commit + push your branch (or open a PR)" in the spawn prompt, and verify the artifact is on a durable ref before sending shutdown.
- Alternatively, for a short doc, have the subagent RETURN the full content in its final message (not just a summary) so it's captured in the transcript even if the worktree is lost.
- Before shutting down any isolation:worktree subagent, confirm its output is on a committed ref (`git log --all -S <marker>`), not just "reported done".
- Relates to [[feedback_reduce_teammate_message_fanout]] (subagents for one-shot work) — the convenience of fire-and-forget subagents has this durability footgun.
