---
name: no-git-stash-in-worktree
description: "Never use `git stash` in an agent worktree — the stash stack is shared across all worktrees of the same .git, so concurrent agents clobber each other's stashes"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

Never run `git stash` / `git stash pop` inside an agent worktree under `/workspace/.claude/worktrees/`.

**Why:** All worktrees of a repo share one `.git` and therefore ONE stash stack. When multiple dev agents work concurrently, `git stash` from agent A and `git stash` from agent B interleave on the same stack. A later `git stash pop` then pops *whoever's* stash landed at `stash@{0}` — not necessarily your own. Observed 2026-05-27 on issue-1602: stashing to test a clean baseline, another agent's #1529 WIP got popped into my worktree and my own 1602 edits were buried deeper in the stack. Recovering required `git stash list` + `git stash apply stash@{N}` by explicit ref and re-stashing the misplaced work with a recovery label.

**How to apply:** To compare against a clean baseline without your changes, do ONE of:
- `git diff > /tmp/mywork.patch`, `git checkout -- <files>`, run baseline, then `git apply /tmp/mywork.patch`; or
- spin up a separate throwaway `git worktree add` on origin/main and run the baseline there; or
- just `git commit` your WIP first (commits are per-branch, not shared) and compare commits.
If you ever DO find a stash collision, never `git stash drop` — use `git stash list` and `git stash apply stash@{N}` by explicit ref, and re-stash any misplaced work with a `MISPLACED-...recover` label so the rightful owner can find it. Related: [[feedback_no_stash_before_merge]].

**Recurred 2026-05-27 on issue-1332** despite this rule: stashed a 1-line runtime.ts fix to measure a baseline; a concurrent agent (issue-1682) pushed its own stash and my entry vanished from the stack entirely (working tree came back clean, fix lost). Recovery was trivial only because the change was tiny and I had the verbatim diff in context — re-applied via Edit. Lesson reinforced: for a SMALL change, never stash at all; if you must measure a baseline, `git commit` the WIP first (per-branch, never shared) or use a throwaway `git worktree add origin/main`.
