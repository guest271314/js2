# Feedback: Prefer Native Multi-Agents With Worktree Isolation

Use native Codex multi-agent delegation as the primary teammate mechanism. Do
not build or prefer a tmux/file-backed parallel harness unless explicitly asked.

For writing agents, create or assign an isolated git worktree before spawning
the agent, then include the absolute worktree path, branch, and write scope in
the spawn prompt. The main checkout is orchestration-only for those agents.

Read-only explorer/planning agents may inspect the main checkout without a
worktree, but they must not edit files.
