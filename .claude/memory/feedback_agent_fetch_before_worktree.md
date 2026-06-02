---
name: feedback-agent-fetch-before-worktree
description: "Agents must `git fetch origin main` before creating their worktree branch — never branch from stale local main"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

When a dev agent starts a task and creates its worktree, it MUST first
`git fetch origin main` so the worktree branches off the FRESHEST origin/main —
not a potentially stale local main pointer.

**Why:** Local `/workspace` often lags origin/main by hundreds of commits
(daemon noise, sync skips, the parent shell rarely pulls). If an agent
worktree branches from local main, it inherits all the stale state and
will hit immediate conflicts when pushing or rebasing.

**How to apply:** Every agent spawn prompt should explicitly say:
```
git fetch origin main
git worktree add /workspace/.claude/worktrees/<branch> -b <branch> origin/main
```

The CLAUDE.md "Worktree creation" rule already says this ("Always branch
from `origin/main` (post-fetch), never from local `main`") but agents
miss it without the explicit `git fetch` step in their prompt. Make
both steps explicit in every dispatch.
