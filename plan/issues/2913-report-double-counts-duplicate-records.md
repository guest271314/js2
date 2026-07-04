---
id: 2913
title: "test262 report + editions double-count duplicate result rows (no dedup by file)"
status: done
completed: 2026-07-02
assignee: ttraenkler/dev-f2
priority: medium
sprint: 69
created: 2026-07-01
feasibility: medium
task_type: bug
area: tooling
goal: developer-experience
related: [2911]
---

# #2913 — Merged test262 report and editions double-count duplicate result rows

Found during the #2911 test262-setup audit.

## Problem

The merged results JSONL contains duplicate rows for some tests, and the report
builders count **every row** with no dedup, so the same test lands in the
pass/total numerator and denominator more than once.

Evidence (committed baselines, measured 2026-07-01):

- `benchmarks/results/test262-current.jsonl` (host): 48,142 records over 48,088
  distinct files → **54 duplicate rows**; **all** in category
  `language/module-code`; **27 of the 54** have _disagreeing_ statuses
  (`compile_error` on one row, `fail` on the other) for the same file.
- `benchmarks/results/test262-standalone-results.jsonl`: 48,117 records over
  48,088 distinct files → **29 duplicate rows**.

Counting sites with no dedup:

- **`scripts/build-test262-report.mjs:846`** — `statuses.total++` /
  `statuses[status]++` runs per record; there is no `seen`/dedup set anywhere in
  `main()` (`scripts/build-test262-report.mjs:822-888`).
- **`scripts/generate-editions.ts`** — buckets each `ResultRecord` with no dedup
  (`normalizeStatus` + per-record accumulate), so editions inherit the same
  double-count.

## Root cause (direction, not yet pinned)

Not enumeration: `findTestFiles` (`tests/test262-runner.ts:2630-2644`) is a
`readdirSync` directory walk + `.sort()` that returns each file once, and
`runTest262Chunk` iterates each `TEST_CATEGORIES` entry once
(`tests/test262-shared.ts:456-470`). The dups are same-category, same-file, and
sometimes carry _different_ statuses — the signature of a **double-WRITE**, most
likely the poison/flake **retry path** in `tests/test262-shared.ts:826-964`
recording both the original and the retry row (the code even warns about a
double-write hazard at `tests/test262-shared.ts:766-774`), or a shard artifact
concatenated twice in `merge-report`
(`.github/workflows/test262-sharded.yml:601-613`).

## Impact

Small in magnitude (~0.1% of the denominator) but it makes the headline pass
rate **non-deterministic** (a duplicated row's status depends on retry timing)
and means host and standalone totals are each computed over a population that is
not exactly one-row-per-test. Because both lanes go through the same
`build-test262-report.mjs`, comparability is preserved, but both numbers are
slightly wrong and can drift run-to-run.

## Fix direction

1. **Defensive dedup in the report builder** — in
   `scripts/build-test262-report.mjs`, key on `record.file` (last-write-wins, or
   deterministic worst-status precedence `compile_error > fail > pass`) before
   counting. Same in `scripts/generate-editions.ts`.
2. **Fix the source of the duplicate write** — trace the retry path in
   `tests/test262-shared.ts:826-964`: ensure exactly one `recordResult` per test
   (the retry must _replace_, not append). Confirm `merge-report` isn't
   concatenating a shard artifact twice.

## Acceptance

- A merged JSONL with N distinct files produces a report whose
  `summary.total === N_official`; duplicate rows never double-count.
- No same-file duplicate rows emitted by the runner for the retry path.

## Implementation status (2026-07-02, dev-callback — handoff to dev-f1)

**Fix Direction 1 (defensive dedup) — DONE + verified on branch
`issue-2913-report-dedup`:**

- `scripts/build-test262-report.mjs`: streaming pass now collects one row per
  `record.file` into a Map with a deterministic WORST-status precedence
  (`compile_error > fail > timeout/crash > pass > skip`), then counts the deduped
  set; prints `#2913: dropped N duplicate row(s); counting M distinct file(s)`.
- `scripts/generate-editions.ts`: same file-keyed worst-status dedup before
  bucketing. Verified against the committed baseline: **48142 → 48088 distinct,
  dropped 54** — exactly the documented duplicate set.
- Regression test `tests/issue-2913-report-dedup.test.ts` (3 cases: worst-status
  on disagreeing dups, order-independence, no-dup passthrough) — green. Report
  builder verified on a synthetic fixture (5 rows → total 3, worst-status wins).
- Byte-safe: only affects duplicate-row counting; a no-dup input is unchanged.

**Fix Direction 2 (source of the duplicate WRITE) — NOT done, now NON-URGENT
follow-up.** With the report deduping, the counts are correct/deterministic
regardless of source. The 54 dups are all `language/module-code`, disagreeing
`compile_error` vs `fail` — the signature of a negative-module test recording
across two handlers (`tests/test262-shared.ts` negative-module path ~L656-728 +
the exec/catch path ~L779-798, which is #1221-guarded for FIXTURE but not the
module-goal path). Deep runner-infra change; recommend a scoped follow-up so the
JSONL itself carries one row per test (matters for baseline promotion hygiene).
