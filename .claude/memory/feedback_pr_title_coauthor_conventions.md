---
name: feedback_pr_title_coauthor_conventions
description: "Follow project PR title conventions and add Codex co-author trailer for Codex-authored commits/PRs"
---

# PR, branch, and co-author conventions

When creating or updating PRs in this project, follow the established project PR
title style: a specific conventional-commit-style title such as
`fix(scope): concise summary` that names the real change. Do not prefix PR
titles with `[codex]`.

For Codex-authored issue work, branch names must follow the project convention:
`codex/<issue-id>-<slug>`, for example `codex/1784-typedarray-packed-lane-storage`.
Do not use vague Codex branch names that omit the local plan issue number.

For Codex-authored commits/PR updates, include a co-author trailer for Codex:

```text
Co-authored-by: Codex <codex@openai.com>
```
