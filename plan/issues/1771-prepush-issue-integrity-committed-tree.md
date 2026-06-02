---
id: 1771
title: "pre-push issue integrity can miss committed dangling dependencies"
status: done
created: 2026-06-01
updated: 2026-06-01
completed: 2026-06-01
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: ci
goal: platform
sprint: 58
related: [1616, 1769]
origin: "Project lead feedback after PR #1013 quality gate failed on a dangling depends_on."
---
# #1771 - pre-push issue integrity can miss committed dangling dependencies

## Problem

PR #1013 failed the GitHub Actions `quality` job in `pnpm run check:issues`
because #1769 declared `depends_on: [1765]`, but #1765's issue file lives in a
separate unmerged PR.

That should have failed before push. The existing pre-push hook runs the full
working-tree issue check, but a dirty worktree can contain uncommitted sibling
issue files that make the local check pass while the pushed commit still fails
CI.

## Acceptance

- Pre-push checks issue dependency integrity against the committed tree being
  pushed, not only the current working tree.
- Dangling `depends_on` references are blocked locally even when the working
  tree contains uncommitted files that would satisfy the dependency.
- The existing working-tree `check:issues` remains in place for duplicate IDs,
  broken links, and normal local feedback.

## Implementation notes

- Added `scripts/check-committed-issue-integrity.mjs`, which reads issue files
  directly from a git tree (`HEAD` by default) using `git ls-tree` / `git show`.
- The pre-push hook now calls that committed-tree checker before the existing
  working-tree `scripts/update-issues.mjs --check` gate.
- The checker validates duplicate issue IDs, filename/frontmatter ID mismatch,
  and dangling `depends_on` edges in the committed tree.
