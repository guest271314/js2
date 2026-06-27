---
id: 2750
title: "Consolidate process docs: prune memory store + slim CLAUDE.md (role-specific law → agent defs)"
status: ready
sprint: Backlog
created: 2026-06-27
updated: 2026-06-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: process
language_feature: none
goal: maintainability
---

# #2750 — Consolidate process docs (memory store + CLAUDE.md)

## Problem

The process surface has accreted faster than it has been pruned. As of
2026-06-27:

- **CLAUDE.md**: 396 lines / 6,633 words / 47 KB / 59 NEVER·ALWAYS·MUST·IMPORTANT
  directives — loaded into **every agent on every spawn**, so its size is a
  per-spawn token tax across thousands of spawns. Much of it is role-specific law
  (merge-queue mechanics, worktree-path rules, dispatch tables) that only one role
  actually needs.
- **Memory store** (`.claude/memory/`): **233 files / ~61K words** (9× the
  CLAUDE.md by word count). A large share are narrow one-issue root-cause notes
  (the "low-recall, recall by `ls`" cluster the index itself flags) that rarely
  fire but cost recall budget every session.

Most of this is **scar tissue** — each rule patched a real incident. That's
healthy learning, but scar tissue only ever accretes; nothing schedules its
removal. This issue schedules it.

## Constraint (non-negotiable)

**Human-reviewable: one small consolidation per PR.** Do NOT land a single
mega-diff that rewrites the memory store or CLAUDE.md wholesale — it would be
unreviewable and risk silently dropping a load-bearing rule. Each PR makes one
small, self-contained consolidation a human can read end-to-end and judge.

## Scope — two workstreams, many small PRs

### A. Memory store prune/consolidate (recommendation #3)

- Move the narrow per-issue root-cause notes into a single searchable
  `plan/log/root-causes.md` (or a small set of grouped docs), one cluster per PR.
- Keep `MEMORY.md` to **cross-cutting invariants** only; each migrated note drops
  its index line and gains a pointer in the consolidated doc.
- **Target**: < ~50 active memory files.
- Per-PR rule: each PR migrates one coherent cluster (e.g. all `project_NNNN_*`
  substrate notes for one subsystem), leaving MEMORY.md consistent.

### B. CLAUDE.md slim → role-specific law into agent defs (recommendation #5)

- Move role-specific sections out of CLAUDE.md and into the agent def that owns
  them, one section per PR:
  - merge-queue mechanics / enqueue rules → PR-queue shepherd (`developer.md`
    shepherd section)
  - dispatch tables / TaskList reconciliation → `tech-lead.md`
  - worktree-path / commit discipline → writer agent defs
- Keep CLAUDE.md to **architecture + the handful of universal invariants**
  (target ~150 lines).
- Benefit: smaller per-spawn context **and** less chance an agent misapplies a
  rule written for a different role.

## Pre-work checkpoint (do first, its own PR)

Before moving anything, run the **"does this failure mode still exist under the
setup we actually run today?"** pass over the rules being consolidated. Some rules
guard configurations no longer in use (e.g. the retired `bgIsolation: "none"`
unblock). Drop dead rules outright rather than relocating them; note each drop in
the PR description with the incident it originally guarded so the history is
recoverable.

## Acceptance criteria

- [ ] Memory store reduced toward < ~50 active files; migrated notes searchable in
      a consolidated doc; `MEMORY.md` index stays consistent after each PR.
- [ ] CLAUDE.md reduced toward ~150 lines; relocated rules live in the owning
      agent def; no universal invariant lost.
- [ ] Every PR under this issue is a single small consolidation (reviewable in one
      sitting); no wholesale rewrite.
- [ ] Each dropped rule is recorded with the incident it guarded.

## Notes

- Related cleanup already landed under this directive: removed retired `tester`
  and `scrum-master` agent defs; folded Scrum-Master process-improvement /
  retrospective duties into `tech-lead.md`.
- **Sprint–budget desync** (separate design problem, may deserve its own issue):
  the sprint unit is sized to ~1 week of **token budget**, not calendar time, and
  that budget is typically burned in <2 days. The pain is NOT cadence/ceremony —
  it's that a **fixed pre-scoped task list** and **budget burn** never line up,
  because per-issue token cost is high-variance and not estimable in advance. Too
  many tasks → strand mid-sprint; too few → run out early; plus sprints get closed
  early exogenously. Proposed direction: stop defining a sprint as a fixed list ≈
  one budget. Instead — (a) plan a **priority order**, keep one **over-provisioned,
  auto-replenished** ready queue (make the ES3/ES5 autofill the standing model, not
  a rescue); (b) treat the **budget meter as the cutoff** — at exhaustion, stop at a
  clean PR boundary and roll the remainder to the top of the queue, so stranding is
  structurally impossible; (c) "sprint" becomes a **retrospective window** stamped
  at budget rollover, not a prospective commitment; (d) tag issues by rough cost
  class (S/M/L/XL), start a window with XLs (max runway) and keep S items as
  always-available tail filler so the budget tail neither strands a big item nor
  sits idle.
