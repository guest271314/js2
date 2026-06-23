---
id: 2630
title: "Protocol: dedicated PR-queue shepherd role + auto-park handling rules"
status: done
completed: 2026-06-23
sprint: Backlog
priority: medium
feasibility: easy
area: process
goal: team-workflow
task_type: docs
created: 2026-06-23
---

## Problem

Two recurring queue-management failures had no protocol backing:

1. **Hand-shepherding the merge queue from the lead loop** strands PRs and burns
   lead attention — the queue had no dedicated owner. The
   `feedback_dedicated_pr_shepherd` memory note captured this but it never made
   it into the protocol.
2. **Bot park-holds were mishandled** — a dev removed a
   `github-actions[bot]` `auto-park-bot:merge-group-failure` park-hold on #1960,
   conflating it with its own manual `hold` label and re-admitting a regressing PR.

## Resolution

Documentation-only change to the team/workflow protocol (no compiler code):

- **`/workspace/CLAUDE.md`** — added the **PR-queue Shepherd** to the roles
  diagram + roles table; added a **PR-queue shepherd (standing role)** subsection
  (primary enqueuer; `auto-enqueue.yml` is the backstop) and an **Auto-park
  handling rules** subsection (rules a–e: never remove a bot park-hold
  undiagnosed; bot park-hold ≠ a dev's manual label; real-regression-vs-flake
  triage before re-enqueue; never re-enqueue in a loop; held PRs are skipped by
  the backstop and strand).
- **`plan/method/team-setup.md`** — added the **PR-queue Shepherd** standing
  teammate role under `## Roles`.

## Acceptance

- The shepherd role and auto-park rules are durable in the protocol docs.
- No compiler source touched.
