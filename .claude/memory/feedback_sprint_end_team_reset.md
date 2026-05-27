---
name: feedback_sprint_end_team_reset
description: "At sprint end, carry over remaining tasks to the next sprint, then disband + recreate the js2wasm team with a fresh tasklist (fixes tasklist desync)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

At the end of each sprint, perform this team/tasklist reset (user-directed 2026-05-25):

1. **Carry over remaining work**: move all still-open TaskList items AND open sprint-N issues (status not done/wont-fix) to the next sprint (e.g. s55 → s56) — update the issues' `sprint:` frontmatter and the dependency graph/backlog.
2. **Disband the team**: `TeamDelete` the `js2wasm` team (this also drops its tasklist — that's intended, after carryover is captured in the issue files).
3. **Recreate it fresh**: `TeamCreate js2wasm`, then populate the NEW tasklist from (a) this sprint's carryovers + (b) the next sprint's (s56) planned backlog. Spawn the dev team against the fresh list.

**Why:** during sprint 55 the `js2wasm` tasklist desynced from the tech-lead worktree session's view (lead saw #60–143; teammates saw a stale #35–90 list + stale checkout), which broke self-serve auto-claim and forced one-shot direct-dispatch + caused duplicate-dispatch churn. A fresh tasklist at the sprint boundary is the clean reset — the right time to do it (not mid-sprint, where TeamDelete would destroy the active list). The carryover step ensures no unfinished work is lost when the list is dropped.

**How to apply:** run this as part of `/sprint-wrap-up` at sprint close, BEFORE dispatching the next sprint. Capture carryovers in the issue files FIRST (source of truth), since TeamDelete wipes the tasklist. Relates to [[feedback_tasklist_sync_unreliable]] (the underlying desync) and [[feedback_diary_and_sprints_before_compact.md]] (persist learnings before destructive boundary ops).
