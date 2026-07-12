---
id: 3189
title: "CI ratchet: hard-fail on uncatchable-trap category GROWTH (null_deref/illegal_cast/oob/unreachable) in the test262 regression gate"
status: ready
created: 2026-07-12
priority: medium
feasibility: medium
task_type: chore
area: test-infra
goal: crash-free
sprint: current
horizon: s
related: [3179, 3186, 3162, 2855, 3102]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, minor findings)"
---

# #3189 — trap-category growth ratchet in the regression gate

## Problem

**349** default-lane fails are uncatchable Wasm traps (baseline 2026-07-12:
`null_deref` 184, `illegal_cast` 88, `oob` 57, `unreachable` 20). Traps escape
`try`/`catch` (documented in #3179 — a trap inside `assert.throws` aborts the
whole test file), so each one poisons every test whose body shares the
pattern. The "crash-free (traps → 0)" goal exists in
`plan/goals/goal-graph.md`, and individual issues fix instances — but **no CI
mechanism prevents the trap population from growing**: the PR gate keys on
`net_per_test > 0` and per-bucket regression counts, so a PR that fixes 60
assertion-fails while introducing 12 new illegal-casts sails through
net-positive. The codebase already uses ratchets successfully for exactly this
shape of problem (`check:ir-fallbacks` for IR fallback buckets #2855;
`check:loc-budget` for god-file regrowth #3102).

## Fix

Extend the existing PR bucket analysis (the `/dev-self-merge` Step-4
bucket-by-path machinery that already diffs `test262-current.jsonl` from
`loopdive/js2wasm-baselines`, per #1528) with a **per-error_category diff for
the four trap categories**:

- For each of `null_deref`, `illegal_cast`, `oob`, `unreachable`: count
  baseline vs PR run.
- **Any growth in any trap category fails the check** (or park-holds via the
  existing auto-park path), independent of net_per_test — with the list of
  newly-trapping test files in the report.
- Decreases auto-bank (same `--update-on-decrease` philosophy as the IR
  ratchet) — no baseline-bump churn (#3131 solved the conflict pattern; reuse
  its conflict-free-baseline approach).

## Verified anchors

- Categories are assigned in `tests/test262-runner.ts` (categorizer doc block
  `:4207`); the four trap categories already exist as stable strings in the
  jsonl.
- Bucket analysis consumer: `dev-self-merge` Step 4 (see
  `.claude/skills/dev-self-merge.md`) + `scripts/diff-test262.ts`.
- Coordinate with #3187 (classifier split) — land #3187 first or together so
  the ratchet baseline is taken on honest categories.

## Acceptance criteria

1. A PR whose test262 run increases any trap-category count vs baseline gets
   a failing/park signal naming the newly-trapping files.
2. Trap-category decreases bank automatically without per-PR baseline-bump
   merge conflicts.
3. Doc: one paragraph in `docs/ci-policy.md` describing the ratchet.

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` — "Minor findings: trap
discipline as a ratchet".
