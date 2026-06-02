---
id: 1781
title: "standalone test262 run must publish full JSONL and root-cause issue map"
status: ready
created: 2026-06-02
updated: 2026-06-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: testing
language_feature: test262-standalone
goal: standalone-mode
es_edition: n/a
sprint: 58
related: [1662, 1776, 1472, 682, 1474, 1599, 1387, 1778]
origin: "Investigation of all failing standalone test262 tests found that the June 1 full standalone JSONL/report artifacts were generated but not retained, leaving only summary counts and five manually documented root-cause clusters."
---

# #1781 - Standalone test262 run must publish full JSONL and root-cause issue map

## Problem

The 2026-06-01 standalone test262 run produced a measured summary of
4,368 / 43,106 passing (10.1%) and referenced these generated artifacts:

- `benchmarks/results/test262-standalone-report-20260601-213702.json`
- `benchmarks/results/test262-standalone-results-20260601-213702.jsonl`

Those full artifacts are not committed, not present in the workspace, and were
not included in the GitHub Pages artifacts I checked for the relevant June 1
runs. The committed public report is `summary_only`, so it preserves the pass
count but not the per-test failure rows, failure signatures, categories, or the
unclassified tail.

That means a later investigator cannot verify that **every failing standalone
test262 test** has an issue file for its root cause. We can only verify the
five root-cause clusters that were manually copied into issue files.

## What is already covered

The preserved June 1 root-cause clusters have issue coverage:

| Root cause                                                         |            Evidence from June 1 run | Issue                                                          |
| ------------------------------------------------------------------ | ----------------------------------: | -------------------------------------------------------------- |
| `isSameValue` externref equality emitted invalid Wasm              |                     13,614 failures | #1776 (done by PR #1025; rerun required to remove stale count) |
| Dynamic object/property operations still need a no-JS-host runtime | 22,986 priority-classified failures | #1472                                                          |
| Native standalone RegExp engine missing                            |        1,882 non-exclusive failures | #682, with Phase-1 refusal in #1474                            |
| JSON parser/stringifier missing in standalone                      |          134 non-exclusive failures | #1599                                                          |
| `with` statement lowering missing                                  |          294 non-exclusive failures | #1387                                                          |

The broader construct-level standalone host-import audit also has issue
coverage in #1662 and follow-ups (#1663, #1664, #1665, #1666), plus existing
owners such as #1103, #1335, #1470, #1473, #1474, and #1599.

## Published artifact

A full standalone rerun was published on 2026-06-02 to
`loopdive/js2wasm-baselines` at commit
`fef6d42c21ffcb933f4916b5f4a8e8eeeb98ec52`:

- `test262-standalone-results-20260602-124735.jsonl`
- `test262-standalone-current.jsonl`
- `test262-standalone-results.jsonl`
- `test262-standalone-report-20260602-124735.json`
- `test262-standalone-current.json`
- `test262-standalone-report.json`

Run command: `TEST262_TARGET=standalone TEST262_REPORTER=dot bash scripts/run-test262-vitest.sh`.
The run used local standalone-runner plumbing on js2wasm commit
`02a143f33a49674faa77f63afc191fb07961d2b8`.

Validated counts:

- JSONL rows: 48,110
- Full summary: 7,788 pass, 6,412 fail, 33,793 compile_error,
  3 compile_timeout, 114 skip
- Official summary: 7,594 pass / 43,128 total (17.6%)
- JSONL SHA-256:
  `9096fce194cad887af6b0642fca7e6df898523684329509ebe752ec6da2edc5e`
- Report SHA-256:
  `91cf08789581b7381566ee482babf765b719fcea9b85a38c5b3e37a6e833aee9`

## Root Cause

Standalone test262 is not a durable, reproducible reporting lane today:

- The current vitest test262 worker hardcodes the default JS-host target.
- The standalone run's full JSONL/report were generated outputs, but only a
  summary-only public report was committed later by #1778.
- The Pages artifacts for the relevant June 1 runs contain the default
  `test262-results.jsonl`, not `test262-standalone-results-*.jsonl`.
- No committed classifier maps standalone failure signatures to issue ids and
  reports unclassified failures.

## Acceptance Criteria

- Add a supported standalone test262 runner mode using the existing vitest
  pipeline, e.g. `TEST262_TARGET=standalone` or an explicit package script.
- The standalone lane writes durable artifacts named
  `test262-standalone-results-<timestamp>.jsonl` and
  `test262-standalone-report-<timestamp>.json`.
- Each JSONL row records enough detail to classify the result: file, category,
  status, error signature, imports/host-import leak class when available, and
  whether execution reached `test()`.
- Publish or retain the full standalone JSONL, not only the summary. Acceptable
  destinations: `loopdive/js2wasm-baselines`, Pages download artifacts, or a
  committed small indexed artifact with the large JSONL fetched on demand.
- Generate a root-cause map from standalone failures to issue ids. The report
  must list every mapped bucket and a separate `unclassified` bucket.
- A CI/check command fails when the standalone root-cause map has unclassified
  failures above an explicit threshold.
- Rerun standalone test262 after #1776 and update the five cluster counts plus
  any newly exposed root causes in their issue files.

## Notes

Do not use this issue to implement the compiler fixes themselves. This issue is
the reporting and auditability layer that lets #1472/#682/#1599/#1387 and the
host-import audit issues be verified against a real standalone test262 corpus.
