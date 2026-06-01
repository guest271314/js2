---
name: Esch teammate worktree isolation
description: Keep any Esch teammate work in its own dedicated worktree and branch; never mix it into Codex or other teammate branches.
type: feedback
---

When working with or taking over work from the `esch` teammate, keep that work
in a separate dedicated git worktree and branch.

**How to apply:**

- Create or use an `esch/...` or otherwise clearly named branch for Esch-owned
  work.
- Put the checkout in its own worktree under the current session's
  `.codex/worktrees/` area.
- Do not commit Esch changes on a Codex issue branch, the root checkout, or
  another teammate's branch.
- If Codex needs to build on Esch's work, open a separate Codex branch from the
  correct base and merge/cherry-pick intentionally instead of editing Esch's
  branch in place.

**Why:** Esch teammate work must remain reviewable and attributable on its own
branch. Mixing it into another session's branch makes diffs hard to audit and
creates the same shared-worktree collision the user explicitly wants to avoid.
