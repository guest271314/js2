---
name: feedback-architect-worktree-isolation
description: Always spawn architect agents with isolation:worktree — they request it every time
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

Always pass `isolation: "worktree"` when spawning architect agents, even when the task only writes to `plan/issues/` (no src/ changes).

**Why:** Architect agents refuse to start without worktree isolation — they send a request-to-respawn message and stall. This happened with architect-820 and architect-779 in session 0ffbd21c. Even for read-only spec writing, the agents have a firm protocol requirement for isolation before writing to shared issue files.

**Exception noted by architect-jsx-runtime:** A specs-only architect can technically work from /workspace on main since it only writes to plan/issues/ (absolute paths, no branch-level conflicts). But the agents themselves enforce the policy, so just always use isolation:worktree to avoid stall-and-respawn cycles.

**How to apply:** In every `Agent(subagent_type: "architect")` call, include `isolation: "worktree"`.
