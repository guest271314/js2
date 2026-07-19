---
name: feedback_cloud_oneshot_dev_when_no_team_feature
description: "Cloud/remote setup: the standing-team feature isn't available — use the one-shot dev model (assignment baked into spawn, terminate after handoff)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 1e44203e-44db-5a22-8024-ecda1dbde6ee
---

**In the cloud / remote Claude Code setup (Claude Code on the web), the standing-team model does NOT work. Use the one-shot dev model instead.**

The environment differs from the local `/workspace` tmux-teammate setup the rest of CLAUDE.md assumes: working dir is `/home/user/<repo>`, a single `origin` remote (no `fork`), no `gh` CLI (GitHub is via `mcp__github__*`), and — critically — two team primitives are missing:

1. **`TaskList` is NOT enabled in a teammate's context.** Spawned devs report "TaskList exists but is not enabled in this context", so they **cannot self-serve** from a shared queue. `sync-current-tasklist.mjs` writes to the file-based `~/.claude/tasks/js2wasm/` store, which the native TaskList tool (what teammates read) does not surface.
2. **`isolation: worktree` is auto-removed when a teammate goes idle.** The spawn→idle→resume-with-assignment flow silently strips isolation: on resume the agent's git commands land in the **shared main checkout** (`/home/user/<repo>`), so `git checkout -B <branch> origin/main` switches the main tree off your working branch and multiple devs collide (confirmed 2026-07-19: a dev hijacked the main checkout off the working branch exactly this way).

**The one-shot model (what works):**
- Spawn each dev with its issue assignment **baked into the spawn prompt** (with `isolation: worktree`). Because it never idles between spawn and work, its worktree survives.
- The dev implements → validates with **scoped** tests (never full test262 — OOM; symlink `node_modules` from the repo root into the worktree first) → pushes its branch → `SendMessage` the lead → **terminates** (one-shot; no "next assignment" loop).
- The **lead opens the PR** (`mcp__github__create_pull_request`) and drives the merge — teammates have no `gh`/GitHub tools.
- Re-spawn a **fresh** dev per issue to keep ~`cores-2` active. Do NOT resume a finished dev with a new task (re-triggers the isolation loss). `--no-verify` on push is sanctioned here (the pre-push hook script is often absent in the worktree; devs validate manually and confirm no `labs/` content).

**Also:**
- **Pre-screen each issue for dev-completability before spawning.** Many `sprint: current` + `ready` issues need an architect spec or batch test262 validation and will bounce (confirmed 2026-07-19: #2726, #2847). Read the issue first; spawn only confirmed locally-verifiable work (tooling / testing / CI / IR-refactor with emit-identity checks). Speculative spawns waste ~40–110k opus tokens each.
- Preserve any partial work from a broken teammate by committing it on its issue branch before restoring the main checkout.

This refines [[feedback_always_use_teammates]] (teammates-vs-subagents is a *local*-setup rule) and pairs with [[feedback_agent_self_termination]] / [[feedback_architect_worktree_isolation]]. When the team feature IS available (local `/workspace`), the standing-teammate model still applies.
