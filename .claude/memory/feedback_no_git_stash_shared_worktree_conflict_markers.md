---
name: feedback_no_git_stash_shared_worktree_conflict_markers
description: "Never git stash/pop in a worktree to A/B-test baselines; pop injects conflict markers into concurrent agents' plan files"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

To compare a change against `upstream/main` (e.g. WAT-diff or a baseline lint
count), do NOT `git stash` then `git stash pop`. The stash stack is shared
across all worktrees on the same `/workspace/.git`, so concurrent agents' edits
(esp. `plan/issues/*.md`) get caught in the stash, and `pop` injects
`<<<<<<< Updated upstream` conflict markers into files you never touched. The
index then shows `both modified` / unmerged paths and a `git commit` silently
includes or chokes on them.

**Why:** confirmed 2026-06-18 on PR #1714 — a stash/pop during a lint baseline
check left conflict markers in 2011/2017/2025/2033/2083 plan files; the commit
pulled them into a half-merged index.

**How to apply:** to read the upstream version of a file, use
`git show upstream/main:path > /tmp/base` (or `git checkout HEAD -- <file>` to
discard) — never stash. To A/B a compiler change, copy the file aside
(`cp file /tmp/head; git show upstream/main:file > file; <test>; cp /tmp/head
file`) instead of stashing the whole tree. If a stash/pop already polluted
sibling files, `git checkout HEAD -- <those files>` to restore (they equal
upstream when you didn't touch them) and verify your commit's `git show --stat`
lists ONLY your files. See [[feedback_no_git_stash_in_worktree]].
