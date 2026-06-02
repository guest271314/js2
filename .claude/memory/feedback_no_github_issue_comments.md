---
name: feedback_no_github_issue_comments
description: "Don't touch GitHub issues opened by users without consent; track work in plan/issues/*.md, not GitHub issues"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

Two related rules about GitHub issues:

**1. Never mutate user-opened GitHub issues without explicit consent.**
Don't post comments to, edit, close, or reopen GitHub issues opened by external users (contributors, guests, reporters) without the user's explicit consent in the current conversation.

**Why:** The user was annoyed when the tech lead posted a status update to issue #389 (opened by guest271314) without being asked. It looked presumptuous toward the reporter. Reinforced 2026-05-29: "dont auto reply, always ask for my consent!" — consent is **per-reply and does NOT carry over**. Even when the user says "let's address issue #389 comment X," that authorizes the *internal* work (code fix, PR) but NOT posting a reply; always draft the reply and ask for explicit consent before each `gh issue comment` / `gh api ... comments` POST.

**2. Do NOT create GitHub issues for internal tracking — use `plan/issues/<id>-slug.md`.**
This project tracks all work in markdown issue files under `plan/issues/`, NOT in GitHub Issues. When a new issue/task is needed, create the `.md` file (frontmatter: id, title, status, priority, etc.) and add it to the dependency graph / backlog. Do not run `gh issue create`.

**Why:** The user pointed out that GitHub issue #572 should have been a `.md` file — "we don't use this." GitHub Issues are only where *external reporters* file things; the team's own backlog lives entirely in `plan/issues/`.

**How to apply:**
- Applies to the tech lead AND all spawned agents (include "Do NOT comment on or create GitHub issues; track work in plan/issues/*.md" in every agent spawn prompt that touches GitHub).
- Issues created by external users on GitHub: read them for context, fix via PR, but don't comment/close/reopen without asking. PR-merge auto-close is fine.
- Need to file a follow-up/sub-issue? Write `plan/issues/<id>-slug.md`. Never `gh issue create`.
- When in doubt: ask first.
