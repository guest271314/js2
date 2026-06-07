---
id: 1908
title: "standalone: re-split and fix residual isSameValue bucket after #1776/#1807"
status: ready
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, testing
language_feature: equality, test262-harness
goal: standalone-mode
related: [1776, 1807, 1623]
test262_bucket: issamevalue-invalid-wasm
test262_count: 5556
---
# #1908 — Residual standalone `isSameValue` bucket

## Problem

The checked standalone report still assigns `5,556` failures to
`issamevalue-invalid-wasm`, even though the earlier focused owners are marked
done:

- `#1776` fixed the original externref invalid-Wasm case.
- `#1807` fixed the async-generator index-shift residual.

The bucket now needs a fresh split against the current report instead of
continuing to point only at completed issues.

## Scope

- Reproduce representative failures from the current standalone report.
- Determine whether the bucket is still invalid Wasm in `isSameValue`, a
  classifier over-match on assertion failures, or a new equality helper bug.
- If it is classifier drift, update `scripts/build-test262-report.mjs` so the
  failures move to their real owners.
- If it is a codegen bug, fix the smallest helper/emitter path and add a focused
  regression test.

## Acceptance Criteria

- The issue documents the current dominant signatures/files for the bucket.
- Either the `issameValue` invalid-Wasm count materially drops on a rebuilt
  standalone report, or the remaining failures are reclassified to more precise
  issues.
- Any code fix has a focused `tests/issue-1908.test.ts` regression.

