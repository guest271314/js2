---
id: 3189
title: "CI ratchet: hard-fail on uncatchable-trap category GROWTH (null_deref/illegal_cast/oob/unreachable) in the test262 regression gate"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-forin-sound
created: 2026-07-12
priority: medium
feasibility: medium
task_type: chore
area: test-infra
goal: crash-free
sprint: 71
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

## Resolution (2026-07-12, dev-forin-sound)

Implemented as a pure, unit-tested extension of the existing `diff-test262.ts`
gate machinery (the same script the required `check for test262 regressions` /
`merge shard reports` guards run) — no new required-check name, no new CI job.

- **`evaluateTrapCategoryGrowth(baseline, newer, tolerance=0)`** (`scripts/diff-test262.ts`):
  per-category population diff for `null_deref` / `illegal_cast` / `oob` /
  `unreachable` (exported `TRAP_ERROR_CATEGORIES`). **Any growth in any trap
  category → gate fail**, independent of `net_per_test`, naming the newly-trapping
  files. Pure (no I/O), mirroring `evaluateRegressionThresholds` (#1943).
- **Wired into `run()`** — applied in BOTH the normal and the oracle-rebase
  branches (a new trap is a real regression regardless of an oracle bump; the
  trap categories aren't touched by any oracle reclassification, so they stay
  comparable across a forward bump). Prints a `Trap categories (baseline →
  candidate)` line every run.
- **Decreases auto-bank, conflict-free**: the ratchet reads the committed
  baseline jsonl that `promote-baseline` re-seeds on every push to main
  (#1528) — no separate ratchet baseline file, so no per-PR baseline-bump merge
  conflict (#3131 pattern, achieved structurally).
- **Noise discipline**: a byte-identical (`wasm_sha`-unchanged) pass→trap flip is
  excluded as CI runner noise (a static miscompile can't appear on an identical
  binary), exactly like the `net_per_test` gate's wasm-hash filter (#1222).
- **Operational safety valve**: `TRAP_RATCHET_TOLERANCE` env (default 0 — strict)
  mirrors `STANDALONE_REGRESSION_TOLERANCE`, so a false-positive against baseline
  drift can be loosened without a code change rather than wedging the queue.
- **Coordination**: lands after / alongside #3187 (classifier split) so the
  ratchet baseline is taken on honest categories. The four trap categories are
  unaffected by #3187's `wasm_compile` split, so the ordering is safe either way.

### Acceptance criteria disposition
1. A PR that increases any trap-category count vs baseline gets a failing gate
   signal (`exit 1`) naming the newly-trapping files. ✓ (unit-tested +
   CLI-smoke-tested: growth → exit 1, flat/shrink → exit 0.)
2. Decreases bank automatically without per-PR baseline-bump merge conflicts —
   the baseline is the promote-refreshed jsonl, no separate file. ✓
3. Doc paragraph in `docs/ci-policy.md` (§3, "Uncatchable-trap growth ratchet"). ✓

Tests: `tests/issue-3189.test.ts` (9 cases — hold/shrink/grow, net-positive-with-
new-traps block, wasm-identical noise exclusion, lateral move, tolerance valve).

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` — "Minor findings: trap
discipline as a ratchet".
