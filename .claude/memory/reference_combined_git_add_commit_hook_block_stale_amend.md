---
name: reference_combined_git_add_commit_hook_block_stale_amend
description: "Running `git add … && git commit …` as ONE compound Bash command is dangerous in this repo: the pre-commit checklist PreToolUse hook blocks the WHOLE command, so the `git add` never runs. A subsequent `git commit --amend` then silently commits the OLD (unstaged) tree — the refactor you thought you committed isn't in the commit, and CI fails on the un-applied change (e.g. oracle-ratchet firing on code you 'removed'). Fix: ALWAYS stage and commit as SEPARATE Bash calls (`git add …` first, verify, then `git commit …`)."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Observed 2026-07-13 (opus-genproto3, PR #3031).** An agent ran
`git add <files> && git commit -m …` as a single compound Bash command. The
pre-commit checklist PreToolUse hook intercepts and blocks the **entire**
command (not just the commit), so the `git add` half never executed. The agent
then did `git commit --amend`, which **silently committed the OLD tree** — its
actual refactor was never staged, so the pushed commit didn't contain the change.
CI failed the **oracle-ratchet** gate TWICE (firing on a `ctx.checker` call the
agent believed it had migrated to `ctx.oracle`) before the agent realized the
refactor wasn't in the commit at all.

**Fix / rule:** stage and commit as **separate** Bash tool calls —
`git add <files>` (let the hook run / verify it staged), THEN `git commit -m …`
as its own call. Never combine `git add && git commit` in one compound command
in this repo. Symptom to recognize: CI fails a gate on code you're sure you
changed, and `git show HEAD --stat` doesn't list your edited file. Related git/gh
gotchas: reference_gh_remove_label_rest_not_pr_edit, the pre-git-commit.sh
reminder behavior in CLAUDE.md.
