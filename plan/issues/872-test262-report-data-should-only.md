---
id: 872
title: "Test262 report data should only update on complete runs"
status: ready
created: 2026-03-29
updated: 2026-07-03
priority: high
feasibility: easy
reasoning_effort: medium
goal: performance
sprint: Backlog
---
# #872 -- Test262 report data should only update on complete runs

## Problem

The report.html shows 1,000 total and 0 passed because an incomplete/interrupted test262 run overwrote the previous complete results. The current setup:

1. test262-results.jsonl is truncated at the start of every vitest run
2. test262-report.json is overwritten with partial data during the run (periodic flush every 500 tests)
3. runs/index.json gets a new entry even for incomplete runs

If the run crashes mid-way (OOM, kill, timeout), the report shows partial/wrong data.

## Fix

1. **Write to temp files during the run**: `test262-results.tmp.jsonl` and `test262-report.tmp.json`
2. **Only rename to final files in afterAll**: `rename(tmp, final)` — atomic on most filesystems
3. **If the run crashes**: temp files are left behind, final files untouched
4. **runs/index.json**: only append in afterAll, not during the run
5. **Precompiler**: same pattern — write to `test262-compile.tmp.jsonl`, rename on completion

This ensures report.html always shows the last COMPLETE run.

## Acceptance criteria

- Interrupted runs don't corrupt report data
- report.html always shows last complete run
- Temp files cleaned up on next successful run
- runs/index.json only contains complete runs

## Reconciliation check — NOT closeable, kept `ready` (2026-07-03)

Checked during the stale-backlog reconciliation. An earlier quick read judged
this "architecturally obsolete," but a rigorous check shows that is **only
partly true** — it is NOT safe to close:

- **Production symptom mitigated (not by this fix):** the committed baseline
  `benchmarks/results/test262-current.json` (what the landing badges read) is
  refreshed ONLY by the `promote-baseline` job in `test262-sharded.yml` on push
  to `main` — i.e. after a COMPLETE sharded run merges. So an interrupted run
  no longer overwrites the deployed report with partial data. That addresses the
  original "1,000 total / 0 passed" landing-page symptom.
- **BUT the local runner still does exactly what the issue flags:**
  `tests/test262-vitest.test.ts` still writes `test262-report.json` incrementally
  (`REPORT_FLUSH_INTERVAL` periodic flush), with no temp-file + atomic-rename.
  A locally interrupted `pnpm run test:262` still leaves partial data in the
  working tree. The acceptance criteria (temp files, atomic rename, `runs/index.json`
  only on complete runs) are **not implemented**.

Verdict: the deployed-report risk is handled by the sharded CI architecture, so
the priority is lower than filed, but the local-runner atomicity work described
here is genuinely unstarted. Kept `status: ready`; consider re-scoping to just
the local-runner temp+rename (small) or downgrading priority — leaving that call
to the PO/lead rather than closing on a false "obsolete."
