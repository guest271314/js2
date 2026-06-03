# Symphony Service

This repo implements Symphony as a Node service in `scripts/symphony.mjs`.

Symphony is a long-running scheduler/runner. It reads eligible work, creates a
deterministic per-issue workspace, runs one coding-agent command in that
workspace, tracks runtime state, retries failures, and exposes logs/status for
the operator.

## Repository Mapping

- Workflow contract: `WORKFLOW.md`
- Tracker adapter: `tracker.kind: markdown`
- Issue source: `plan/issues/<id>-<slug>.md` frontmatter
- Workspace kind: `git_worktree`
- Workspace root: `.codex/worktrees/symphony/`
- Runtime logs/state: `.codex/symphony/`

The current tracker adapter is markdown-backed because sprint membership and
issue status are already canonical in repo frontmatter. A Linear adapter can be
added later without changing the orchestrator or runner contracts.

## Issue Status Flow

- `ready`: claimable by Symphony.
- `in-progress`: claimed, running, or resumable by an existing retry.
- `in-review`: worker published a PR or handed off for lead review.
- `done` / `wont-fix`: terminal.

On dispatch, Symphony immediately flips the issue frontmatter from `ready` to
`in-progress` in the main checkout and mirrors that status into the assigned
worktree issue file. `WORKFLOW.md` uses `tracker.claimable_states: [ready]` for
fresh dispatch and `tracker.active_states: [ready, in-progress]` for
reconciliation/retries, so a claimed issue is not picked again as fresh work and
is not cancelled just because the claim state changed.

## Agent Lanes

Agents are configured as lanes in `WORKFLOW.md`.

Each lane has:

- `name`
- `kind` such as `codex`, `claude`, or `generic`
- `role` such as `team-lead` or `teammate`
- `command`
- `prompt_mode`: `argument` or `stdin`
- `max_concurrent`

This is what makes Symphony generic. The scheduler does not care whether a
worker is Codex, Claude Code, or another coding agent. It only needs a command
that can receive the rendered prompt and run in the assigned workspace.

By default:

- Codex uses `codex.command` unless `SYMPHONY_CODEX_COMMAND` overrides it.
- Claude uses a `claude-channel` lane. Symphony sends dispatch events to an interactive Claude Code team lead instead of launching `claude -p` workers.

Start Claude Code with the project channel enabled:

```bash
claude --dangerously-load-development-channels server:symphony
```

The channel server is configured in `.mcp.json` and implemented in `scripts/claude-symphony-channel.mjs`. Claude receives dispatches as channel events and should use native Claude Code Team/TaskList tools to populate or update teammate work. It can call channel tools to reply, claim, complete, or release a Symphony issue.

Example mixed run:

```bash
SYMPHONY_CODEX_COMMAND='codex exec --sandbox workspace-write --ask-for-approval never' \
pnpm run symphony -- --sprint 58 --max 4
```

## Claude Code Channel

Claude Code channels are MCP servers that push events into an already-running Claude Code session. The project channel is configured in `.mcp.json`:

```bash
claude --dangerously-load-development-channels server:symphony
```

When Symphony dispatches to a `claude-channel` lane, it writes a dispatch event to `.codex/dispatch/messages.jsonl`. The channel server watches that file and emits `notifications/claude/channel` into the Claude session. The Claude lead should then use native Claude Code Teams and TaskList tools. Claude can call channel tools to reply, claim, complete, or release the Symphony channel claim.

If no Claude session is running with the channel enabled, the message remains in `.codex/dispatch/` and will be delivered when the channel server starts.

## Commands

```bash
pnpm run symphony:dry-run
pnpm run symphony -- --sprint 58 --max 3
pnpm run symphony:once -- --sprint 58 --max 3
pnpm run symphony:status
```

Use `--dry-run` first. It exercises workflow loading, issue scanning, lane
selection, and dispatch planning without creating worktrees or launching
agents.

## Safety Posture

- The service refuses to launch an agent in `/workspace`.
- Every agent subprocess runs with `cwd` set to its assigned workspace.
- Workspace paths are sanitized and must stay under the configured workspace
  root.
- Worktrees are preserved after runs. Terminal-state reconciliation cancels
  active runs but does not remove worktrees without operator inspection.
- The configured Codex command controls Codex approval/sandbox behavior.
- Claude Code team work stays inside the interactive Claude session. Symphony only sends channel events to the Claude lead; it does not edit Claude-generated team/task files and does not launch `claude -p` unless a separate executable Claude lane is explicitly configured.

## Current Scope

Implemented:

- workflow loader with YAML frontmatter and strict prompt variables
- markdown issue tracker adapter
- bounded concurrency and lane selection
- deterministic git-worktree workspace creation/reuse
- before/after workspace hooks
- generic command runner
- Claude Code channel lane for interactive Claude team-lead dispatch
- structured JSONL logs
- runtime state snapshot
- retry/backoff and stall reconciliation

Not implemented yet:

- Linear tracker adapter
- Codex app-server JSON-RPC client
- optional HTTP status API
- durable DB beyond restart-readable repo/tracker/workspace state
