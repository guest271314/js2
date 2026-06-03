---
name: feedback_no_checkout_apply_cycle_loses_edits
description: "Don't baseline-compare via `git checkout -- <file>` + `git apply patch` while iterating — it silently reverts later working-tree edits"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

When A/B-comparing a fix against `main`, I saved a diff to `/tmp/x.patch`, ran `git checkout -- src/...` to test baseline, then `git apply /tmp/x.patch` to "restore." But the patch captured an EARLIER version of my edits — a later refinement (a discriminator condition) made after the patch was saved got silently reverted to the stale patch content. I didn't notice until the pre-commit lint hook flagged the stale `if (false && ...)` line, and lint-staged's backup/restore then re-clobbered the working tree to the staged (stale) copy.

**Why:** `git checkout -- <file>` + `git apply <patch>` is NOT a round-trip when the working tree has advanced past the patch. lint-staged also stashes/restores on lint failure, which can wipe uncommitted edits.

**How to apply:**
- To compare against baseline, prefer a SEPARATE throwaway worktree/clone, or `git stash` is banned in worktrees ([[feedback_no_git_stash_in_worktree]]) — instead `git show HEAD:path > /tmp/baseline-copy` and diff/run against that copy, leaving the working tree untouched.
- Re-save the patch immediately before any checkout if you must use the patch route, and after restoring, `grep` for a sentinel from your LATEST edit to confirm it survived.
- After any lint-staged FAILED run, re-verify the working tree with `grep` — it reverts to the staged snapshot, which may be older than your latest edits.
