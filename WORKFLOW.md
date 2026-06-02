---
tracker:
  kind: markdown
  issues_dir: plan/issues
  sprint: latest
  active_states: [ready, in-progress]
  claimable_states: [ready]
  claim_state: in-progress
  terminal_states: [done, wont-fix]
polling:
  interval_ms: 30000
workspace:
  kind: git_worktree
  root: .codex/worktrees/symphony
  base_ref: origin/main
  branch_prefix: symphony
hooks:
  timeout_ms: 60000
  after_create: |
    if [ -d /workspace/node_modules ] && [ ! -e node_modules ]; then
      ln -s /workspace/node_modules node_modules
    fi
agent:
  max_concurrent_agents: 8
  max_turns: 1
  max_retry_backoff_ms: 300000
  lanes:
    - name: codex-developer
      kind: codex
      role: teammate
      command: $SYMPHONY_CODEX_COMMAND
      prompt_mode: argument
      max_concurrent: 8
codex:
  command: codex exec -c approval_policy="never" --sandbox danger-full-access --skip-git-repo-check --json
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
logging:
  root: .codex/symphony
---

You are working on js2wasm through Symphony.

Issue: {{ issue.identifier }} - {{ issue.title }}
Issue file: {{ issue.file }}
Sprint: {{ issue.sprint }}
Workspace: {{ workspace.path }}
Branch: {{ workspace.branch }}
Attempt: {{ attempt }}
Agent lane: {{ agent.name }} ({{ agent.kind }} / {{ agent.role }})

Rules:

- Work only inside the assigned workspace.
- Do not edit the main checkout directly.
- Read `AGENTS.md`, `.claude/memory/MEMORY.md`, and the assigned issue file before substantial work.
- Handle exactly this issue; do not claim or self-serve another task.
- Write focused tests in `tests/issue-{{ issue.identifier }}.test.ts` unless the issue says otherwise.
- Run scoped validation only; do not run full local test262.
- Update the issue file on the implementation branch with final findings and status.
- Commit all issue changes on the assigned branch with a Claude Code-style message and a
  `Co-authored-by: Codex <codex@openai.com>` trailer.
- Merge or rebase `origin/main` into the assigned branch before publishing so the PR is based on
  current main.
- Push the assigned branch to `origin`.
- Open a ready, non-draft pull request against `main`; do not mark the issue `done` until the PR
  exists.
- Record the PR number in the issue frontmatter as `pr: <number>` and leave the issue
  `status: in-review`; the PR-status poller flips it to `done` after GitHub reports the PR merged.
- Enqueue the PR in the merge queue when GitHub accepts it. If required checks are still pending,
  enable auto-merge/merge-queue entry so GitHub queues it as soon as checks pass.
- Report changed files, validation, commit SHA, PR URL, and merge-queue or auto-merge state before
  exiting. If any publish or enqueue step fails, leave the issue `in-progress` and report the
  blocker instead of calling the task complete.
