---
id: 3344
title: "CI: baseline promote pipeline can hang indefinitely + emergency workflow_dispatch retrigger loses change-set scoping"
status: done
completed: 2026-07-17
sprint: 72
priority: critical
horizon: m
feasibility: medium
task_type: ci-fix
area: ci
created: 2026-07-17
related: [3227, 3303, 3111, 3161, 1668]
origin: "the #3227/#3201 oracle v6→v7 honest-drop baseline could not publish — the promote job's git-over-SSH push to js2wasm-baselines hung ~2.5h with no timeout, and an emergency workflow_dispatch retrigger could not reproduce the organic change-set scoping"
---

# #3344 — Harden the baseline promote pipeline (push timeout + workflow_dispatch scoping)

## Problem

**Corrected scope (2026-07-17).** The original framing — "the catastrophic
regression guard ignores the `regressions-allow` ceiling" — was **wrong**. A
deeper trace disproved it: `scripts/diff-test262.ts` already calls
`readRegressionsAllowance()` unconditionally in oracle-rebase mode (arm-1
auto-discovery from the change-set's own issue files), and the #1668/#1897
guards already treat the script's exit code as authoritative on PASS (#3303).
The organic push run on the #3201 merge **passed** the gate. The guard is NOT
neutered and needs no `REGRESSIONS_ALLOW_FILE` wiring.

The REAL reason the honest oracle-v7 baseline could not publish was two
CI-robustness gaps in the promote pipeline:

1. **PRIMARY — no timeout on the promote push.** The
   `promote merged report to main baseline` job (`test262-sharded.yml`) runs a
   git-over-SSH clone/push to `loopdive/js2wasm-baselines` with **no
   step-level `timeout-minutes`**. On 2026-07-17 that push hung ~2.5h with no
   progress, consuming the job budget and stranding the promote — so the fresh
   v7 baseline (JS-host 32,138/43,106, standalone 24,711/43,106; the expected
   −650 async-drain correction) never reached the baselines repo, and the
   merge queue kept diffing the stale oracle-6 floor.

2. **SECONDARY — `workflow_dispatch` lost change-set scoping.**
   `resolveChangeBase` (`scripts/lib/change-scope.mjs`) whitelisted only
   `pull_request` / `merge_group` / `push` for the synthetic-merge-parent fast
   path. An **emergency manual retrigger** (`workflow_dispatch`) against a real
   merge-commit SHA therefore could NOT reproduce the organic scoping (the
   PR's own change-set, incl. its `regressions-allow:` declaration) — it fell
   through to the coarser merge-base arm.

## Fix

1. Add `timeout-minutes: 10` to the baselines-repo push step (and to the
   sibling main-repo summary push, same hang class), so a hung SSH push fails
   FAST and is retriable (via a `push`/`workflow_dispatch` re-run) instead of
   wedging the promote pipeline for the whole job budget. The existing
   re-anchor loop still handles transient push races within that window.

2. Add `workflow_dispatch` to the `resolveChangeBase` synthetic-merge-parent
   whitelist, INSIDE the existing `HEAD^2` guard. Backward-compatible: an
   ordinary branch-tip dispatch has a single-parent HEAD, so the guard no-ops
   and it falls through to the merge-base arm exactly as before; only a
   dispatch against a real 2-parent merge commit now reproduces the organic
   `ci-merge-parent` scoping.

## Acceptance

- The promote push cannot hang indefinitely — a step timeout bounds it and a
  re-run publishes the pending baseline. (`tests/issue-3344.test.ts` asserts
  both push steps carry `timeout-minutes`.)
- An emergency `workflow_dispatch` retrigger against a real merge-commit SHA
  resolves the change base to `HEAD^1` (`ci-merge-parent(workflow_dispatch)`),
  while a single-parent branch-tip dispatch still resolves to the merge-base
  arm. (`tests/issue-3344.test.ts` pins both.)
- The catastrophic guard is unchanged and NOT neutered — it still fails on a
  genuine regression lacking a declared ceiling (the #3303 exit-code contract,
  already covered by `tests/issue-3303.test.ts`, is untouched).

## Non-goals
- Do NOT hand-push a baseline to js2wasm-baselines (bypasses CI validation).
- Do NOT lower/disable the catastrophic guard globally.
- Do NOT wire `REGRESSIONS_ALLOW_FILE` into the guard — it is already wired via
  arm-1 auto-discovery.
