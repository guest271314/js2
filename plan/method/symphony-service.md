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
- `in-review`: worker published a PR; Symphony monitors it until merge or a
  failed-CI repair dispatch.
- `done` / `wont-fix`: terminal.

On dispatch, Symphony immediately flips the issue frontmatter from `ready` to
`in-progress` in the main checkout and mirrors that status into the assigned
worktree issue file. `WORKFLOW.md` uses `tracker.claimable_states: [ready]` for
fresh dispatch and keeps `ready`, `in-progress`, and `in-review` active for
reconciliation. A published issue is therefore monitored without being picked
again as fresh work.

By default, candidate dispatch is limited to the selected sprint. A scoped
workflow can set `tracker.include_dependencies: true` to add only that sprint's
transitive `depends_on` closure to the candidate pool. Normal state, claim,
blocking, and priority checks still apply, and unrelated work from another
sprint remains out of scope.

## Pull Request Reconciliation

Symphony records the assigned `branch` at dispatch. Workers record
`pr: <number>` and leave the issue `in-review`; if that metadata write is
missed, Symphony discovers the PR by its assigned head branch and writes the PR
number itself. On every configured PR polling interval Symphony asks GitHub for
the PR head and check rollup:

- A merged PR for an `in-review` issue changes the issue to `done`, records the
  merge date in `completed`, releases any broker claim/retry, and immediately
  makes completed dependencies visible to the normal candidate scan.
- A merged PR for an `in-progress` multi-slice issue clears the old PR, records
  it in `last_merged_pr`, and returns the issue to `ready` for its next slice.
  The next slice always receives a fresh Symphony branch named from the issue
  and merged PR, such as `symphony/porffor/2953-after-pr-3128`. The durable
  merge key prevents restart from requeueing the same merged PR, and branch PR
  discovery ignores that already-handled PR so it cannot bind the next slice to
  a stale merged review.
- A failed check rollup changes the issue back to `in-progress` and dispatches
  a repair attempt in the same deterministic workspace. If that workspace does
  not exist, Symphony checks out the PR's actual head branch from `origin`.
- Each failed head SHA is dispatched at most once. Symphony persists the
  handled SHA as `last_ci_retry_head` in the issue and mirrors it into the
  worker branch, together with the discovered PR `branch`. Restart or a
  transient workspace failure therefore cannot reset the guard or switch the
  repair onto a new branch. A subsequent push gets a new SHA and can trigger
  another repair if its checks fail; an unchanged stale failure cannot create a
  dispatch loop.
- Pending or passing open PRs remain `in-review`. Symphony leaves merge-queue
  enrollment to the worker contract.
- If a worker exits successfully while the issue remains `in-progress` without
  a PR, Symphony first checks the assigned branch for a fresh PR. If none
  exists, it moves the issue back to `ready` instead of treating the run as
  complete. That keeps a missed PR creation from stranding the slice outside
  the claimable queue.

PR polling errors are logged without changing issue state. The standalone
`issues:pr-status` poller remains useful for non-Symphony issues, but Symphony
does not depend on it for its own workers.

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

- Codex uses `gpt-5.6-sol` through `codex.command` unless
  `SYMPHONY_CODEX_COMMAND` overrides the full command.
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

## Scoped Porffor Workflow

`WORKFLOW.porffor.md` isolates the optional Porffor backend chain in the
`porffor-backend` sprint. It uses one `gpt-5.6-sol` lane, a dedicated worktree
and log root, and initializes only the optional `vendor/Porffor` submodule in
worker worktrees. Start and inspect it with:

```bash
pnpm run symphony -- --workflow WORKFLOW.porffor.md --dry-run --json
pnpm run symphony -- --workflow WORKFLOW.porffor.md
pnpm run symphony -- --workflow WORKFLOW.porffor.md --status --json
```

The workflow sets `tracker.include_dependencies: true`,
`pull_requests.sprint_only: true`, and
`pull_requests.include_dependencies: true`. Fresh candidate dispatch and PR
reconciliation therefore include the Porffor sprint plus its transitive
prerequisites. Symphony can continue multi-slice #2953/#2956 work until P1/P3
unblock, but it cannot consume unrelated work from the broad `current` sprint.
Workers leave a multi-slice prerequisite `in-progress` while unchecked slices
remain so each merged PR requeues the next slice; only the final PR uses
`in-review` and closes the issue on merge. Every continuation slice gets a new
branch after the previous PR merges; workers must publish from the branch named
in their prompt rather than pushing another slice to an already-merged branch.

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
- merged-PR completion and failed-CI repair reconciliation

Not implemented yet:

- Linear tracker adapter
- Codex app-server JSON-RPC client
- optional HTTP status API
- durable DB beyond restart-readable repo/tracker/workspace state
