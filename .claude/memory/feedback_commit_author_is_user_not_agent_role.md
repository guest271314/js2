---
name: feedback_commit_author_is_user_not_agent_role
description: "Commits made by Claude/agents must be authored by the USER (Thomas Tränkler <git@thomas.traenkler.com>) + Claude co-author — NEVER the agent role name (senior-dev). Container global ~/.gitconfig had it wrong since 2026-07-14."
metadata:
  node_type: memory
  type: feedback
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

**User directive (2026-07-20):** commits made by Claude/agents must ALWAYS be authored
by the USER — "ttraenkler" = **Thomas Tränkler <git@thomas.traenkler.com>** (their primary
identity, 2137 commits) — with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` as
co-author. NEVER the agent role name.

**Why:** the container's GLOBAL `~/.gitconfig` had `user.name=senior-dev`,
`user.email=claude.ai@loopdive.com` (set 2026-07-14). All agent commits inherit the global
config (worktrees don't override it), so 379 commits landed on main mis-authored "senior-dev"
before the user noticed. The co-author (Claude) was correct all along; only the AUTHOR was wrong.

**How to apply:**
- Fixed 2026-07-20: `git config --global user.name "Thomas Tränkler"` +
  `git config --global user.email "git@thomas.traenkler.com"`. All worktrees/agents inherit it.
- **Verify `git config --get user.name` is NOT a role name before committing from any fresh
  env / after any resume.** If it reverted, re-fix.
- **Already-published commits (public main = append-only) CANNOT be re-authored.** But UNMERGED
  PR-branch commits CAN — re-author with `git commit --amend --reset-author --no-edit` (single)
  or `git rebase origin/main --exec "git commit --amend --no-edit --reset-author"` (multi,
  non-interactive), preserve the Claude co-author trailer, force-push to `fork` (unmerged
  branch = safe, NOT main). Did this for observability PRs #3442/#3445.
- User uses 4 emails (all "Thomas Tränkler"); primary = git@thomas.traenkler.com. Offer to
  switch to github.com@loopdive.com (loopdive work email) if they prefer work-context attribution.

See [[feedback_pr_title_coauthor_conventions]], [[feedback_public_main_append_only]].
