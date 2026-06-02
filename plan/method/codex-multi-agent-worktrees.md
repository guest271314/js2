# Codex Multi-Agent Worktrees

Native Codex multi-agents are the primary delegation mechanism. For read-only
research, spawn an `explorer` or role agent directly. For writing work, create
or assign an isolated git worktree first, then spawn the agent with that path as
its authoritative checkout.

## Default Rule

- Explorers/planners: may inspect the main checkout, must not edit files.
- Developers/senior-developers/workers: must write only in their assigned
  worktree.
- The orchestrator stays in the main checkout and owns integration, review, and
  final git decisions.

## Worktree Shape

Use repo-local worktrees under:

```text
/workspace/.codex/worktrees/<agent-or-issue>
```

Branch names should be explicit:

```text
codex/<agent-or-issue>
```

Prefer a fresh base:

```bash
git fetch origin
git worktree add .codex/worktrees/<agent-or-issue> -b codex/<agent-or-issue> origin/main
```

If repairing a PR, base the worktree on the PR branch or merge ref intentionally
and say so in the spawn prompt.

## Spawn Prompt Requirements

Every writing-agent prompt must include:

- assigned absolute worktree path
- assigned branch
- allowed write scope
- explicit statement that the main checkout is orchestration-only
- reminder not to revert or overwrite other agents' changes
- project PR convention: conventional title and
  `Co-authored-by: Codex <codex@openai.com>` for Codex-authored commits

Minimal template:

```text
You are a Codex <role> teammate for js2wasm.

Assigned worktree: /workspace/.codex/worktrees/<name>
Assigned branch: codex/<name>
Main checkout: /workspace, orchestration-only.

Do all reads, writes, tests, and git commands from the assigned worktree unless
I explicitly say otherwise. Do not edit the main checkout. Do not revert or
overwrite changes made by other agents. Your write scope is: <files/modules>.

Before substantial work, read AGENTS.md and .claude/memory/MEMORY.md from the
repo. When done, report changed files, validation run, branch, and any blockers.
```

## Parallel Work

Parallel writing agents need disjoint ownership:

- split by issue, module, or file set
- state the allowed write set in each spawn prompt
- avoid two agents editing the same compiler function
- use explorers for overlapping analysis instead of overlapping edits

If a conflict appears, the worker reports it and stops rather than resolving
another agent's work blindly.

## Cleanup

Do not remove a worktree until:

- the agent has reported final status
- `git -C <worktree> status --short` has been inspected
- useful changes are merged, copied, or intentionally discarded
- any PR/branch state is understood
