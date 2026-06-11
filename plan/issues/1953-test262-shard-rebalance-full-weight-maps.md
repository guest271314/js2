---
id: 1953
title: "test262: shard durations spread 32–153s — regenerate weight maps with full per-test coverage"
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: low
sprint: 61
area: ci
---
## Problem

The CI shard wall-clock is set by the slowest of the 57 chunks. On the first
post-#1311 run (27309868379), shard job durations spread **32s → 153s**
(p50 110s) — i.e. ~40s of every run's wall is pure imbalance.

Root cause: `tests/test262-slow-tests.json` only carried **189 entries**
(refresh threshold 1000ms). The other ~47,900 tests were assumed a uniform
`DEFAULT_TEST_WEIGHT_MS` = 250ms by `assignBalancedChunk` — but the real
distribution (baseline JSONL, 2026-06-10) is nothing like uniform:

| compile+exec | tests |
|---|---|
| ≤10ms | 5,005 |
| 10–50ms | 17,847 |
| 50–250ms | 18,257 |
| 250–400ms | 5,806 |
| >400ms | 967 |
| untimed (skip etc.) | 235 |

Roughly half the corpus runs in ≤50ms, yet each such test was weighted 250ms —
so bins stuffed with fast/skipped tests came out tiny (the 32s shard) while
compile-heavy bins overflowed (the 153s shard).

## Fix (implemented by this issue's PR)

- `scripts/refresh-slow-tests.mjs`: clamp emitted weights to ≥1ms (the loader
  in `tests/test262-shared.ts` drops 0 values), so `--threshold 0` produces a
  **full map** including near-zero and untimed (skip) tests.
- Regenerate both maps from the current baselines-repo JSONLs with
  `--threshold 0`: `tests/test262-slow-tests.json` (host) and
  `tests/test262-slow-tests-standalone.json`.
- Verified by simulating `assignBalancedChunk` offline against ground-truth
  durations (see PR description for predicted spread before/after).

## Refresh policy

Re-run `node scripts/refresh-slow-tests.mjs --threshold 0` (and
`--target standalone`) whenever shard durations visibly skew again — compiler
perf changes shift the distribution. Source JSONLs come from
`scripts/fetch-baseline-jsonl.mjs` / the baselines repo.
