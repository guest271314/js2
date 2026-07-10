---
name: feedback_bare_tasklist_items_need_issue_id_for_claim_gate
description: "Always use scripts/claim-issue.mjs (the issue-assignments git ref) when claiming work, not just the TaskList owner field — and allocate an issue id even for lightweight/infra tasks so the claim gate has something to attach to"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

User directive (2026-07-02): use the claim gate when claiming tasks.

**Why:** TaskList `owner` is a soft, race-prone signal (agents claim near-simultaneously, updates can cross). The real collision-prevention mechanism is `scripts/claim-issue.mjs` against the `issue-assignments` git ref — an atomic, durable lock. Confirmed twice in one session (2026-07-02): (1) task `#35` (auto-refresh-prs.yml fix) started as a bare TaskList item with NO issue id — three separate agents (opus-2b/opus-3b/opus-4) converged on it because there was nothing for the claim gate to lock; the collision only resolved via manual lead intervention, not the gate. (2) task `#2959` (async Promise executor) worked correctly — an agent held the claim ref and could see a predecessor's abandoned branch was genuinely inactive rather than a live competing claim.

**How to apply:** (a) when routing/spawning any agent, always instruct it to claim via `scripts/claim-issue.mjs`, not just set the TaskList owner field. (b) For lightweight tasks that don't yet have an issue id (CI fixes, infra tweaks, quick triages) — allocate one via `--allocate` before dispatching multiple agents at that priority tier, specifically so the claim gate can protect it; don't leave meaningful work as a bare TaskList-only item when more than one agent might reach for it. (c) When two same-team agents get overlapping priority lists (see [[feedback_same_team_agents_race_same_task_different_conclusions]]), the claim gate is the first line of defense — but only works if every task in the list has an id to claim.
