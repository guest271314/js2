---
name: feedback_worktree_symlink_dependencies
description: Symlink heavyweight local dependencies when creating worktrees
type: feedback
---

When creating a repo worktree, always symlink heavyweight local dependencies
from the canonical workspace instead of leaving empty directories:

- `test262`
- `node_modules`

**Why:** Page builds, edition generation, test262 tooling, and local package
scripts expect populated `test262/test` and installed dependencies. Empty
directories make validation fail later with misleading "missing checkout" or
"node_modules missing" errors.

**How to apply:** The automatic path is
`scripts/provision-worktree-deps.sh`, wired through
`.claude/hooks/provision-worktree.sh` after `git worktree add`. Run
`pnpm run worktree:provision` manually to repair existing worktrees. Since
`test262` is a git submodule path, keep `test262/` as a directory and symlink
its populated contents from the canonical workspace; `node_modules` can be a
direct symlink. If the canonical workspace does not have `test262` or
`node_modules` populated yet, initialize/install them there first.
