---
id: 1778
title: "landing page JS-host toggle should show real standalone test262 pass rate"
status: done
created: 2026-06-02
updated: 2026-06-02
completed: 2026-06-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: landing-page
language_feature: n/a
goal: developer-experience
sprint: 58
es_edition: n/a
related: [925, 959, 1201, 1583, 1662, 1777]
origin: "Project lead report on 2026-06-02: when the JS host checkbox is unchecked on the landing page, the pass-rate stat should show the real standalone-mode test262 number instead of an estimate."
---
# #1778 - landing page JS-host toggle should show real standalone test262 pass rate

## Problem

The landing-page conformance view has a JS host checkbox next to the test262 pass-rate donut. When that checkbox is unchecked, the UI should show the real standalone-mode test262 pass count and pass percentage.

Today the page appears to derive the no-host number by scaling the default JS-host pass count from feature-row host support:

- hostOffPassScale() computes a ratio from feature row badges.
- applyHostMode() applies that ratio to summary.pass.
- The donut caption then labels the result as a standalone estimate.

That is useful as a rough feature-level hint, but it is not the real standalone test262 result. The public pass-rate surface should not invent a standalone number when a measured standalone baseline is available or can be published.

## Likely source

The relevant page code is in website/index.html, especially:

- #host-support-toggle
- #compat-pass-rate / #compat-pass-rate-label when the headline stats are enabled
- hydrateConformanceEditionFilter()
- hostOffPassScale()
- applyHostMode()
- applyConformanceOptions()
- window.updateConformanceDonut

The current data fetch uses:

https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-current.json

The fix likely needs a real standalone-mode baseline artifact, either in the same baselines payload or in a separate published JSON file. Do not infer standalone pass/fail counts from feature badges.

## Acceptance criteria

- With JS host checked, the landing page keeps showing the current default/JS-host test262 pass rate and count.
- With JS host unchecked, the landing page shows the real standalone-mode test262 pass rate and count.
- The donut, headline pass-rate stat, pass-count copy, and caption/subtitle all agree on the same selected mode.
- The no-host label no longer presents the metric as a standalone estimate when real standalone data is being shown.
- If real standalone data is unavailable, stale, or missing for the selected scope, the UI exposes an explicit unavailable/stale/fallback state instead of silently showing an invented estimate.
- Strict-mode and edition/proposal scope filters continue to work with the selected host mode, or clearly document unsupported combinations in the UI behavior.
- Add a focused DOM/browser regression check if the repo already has a suitable path; otherwise document manual verification by toggling JS host on the landing page.

## Non-goals

- Running a new full standalone test262 baseline inside this issue unless producing/publishing the data artifact is required for the UI fix.
- Changing compiler behavior or standalone lowering semantics.
- Reworking the entire feature table host-support model.

## Implementation notes - 2026-06-02

The worktree was missing this issue file, but it exists in planning commit
`17c0fe7a236079fa2653b6e890e920536fb696a8`. Restored the issue file on this
implementation branch before closing it.

Root cause confirmed in `website/index.html`: host-off mode used
`hostOffPassScale()` and `applyHostMode()` to multiply the JS-host pass count by
a feature-row badge heuristic, then labelled the result as a standalone
estimate. That violated the public data contract because the pass count was not
from a standalone test262 run.

Fix:

- Removed the feature-row heuristic from the conformance donut path.
- Added a standalone data loader that prefers embedded standalone fields in
  `test262-current.json`, then tries a future baselines artifact at
  `test262-standalone-current.json`, then falls back to the published local
  `./benchmarks/results/test262-standalone-report.json`.
- Added `website/public/benchmarks/results/test262-standalone-report.json` and
  `public/benchmarks/results/test262-standalone-report.json` with the measured
  Sprint 58 standalone result: 4,368 / 43,106 (10.1%) from
  `test262-standalone-report-20260601-213702.json`.
- Marked that summary artifact as `summary_only` because the full generated
  standalone report/JSONL is not committed and the sprint notes preserved only
  the measured pass/total summary. Follow-up #1781 now records the 2026-06-02
  published standalone rerun in `loopdive/js2wasm-baselines`
  (`test262-standalone-current.jsonl` / `test262-standalone-current.json`) and
  still tracks the root-cause issue map. The donut maps the non-pass remainder
  into the fail segment for geometry rather than inventing CE/skip buckets.
- Added an explicit unavailable state for standalone strict/proposal/edition
  scopes when no measured standalone summary exists for that selected scope.
- Updated `scripts/build-pages.js` so the standalone report is copied into the
  Pages artifact.

Focused validation:

```bash
pnpm exec vitest run tests/issue-1778.test.ts
```

No full local test262 run was performed.

## Codex verification update - 2026-06-02

Confirmed the landing-page host-off conformance path no longer calls the
feature-row heuristic and instead renders from standalone baseline data. Added a
small follow-up hardening pass so stale standalone summaries render the explicit
unavailable state, and so the optional headline pass-rate stat is updated from
the same selected summary as the donut when that stat block is present.

Focused validation:

```bash
pnpm exec vitest run tests/issue-1778.test.ts
pnpm exec prettier --check tests/issue-1778.test.ts scripts/build-pages.js
```

`pnpm exec prettier --check website/index.html` still reports formatting drift
for the full pre-existing HTML page, so no broad page reformat was applied. No
full local test262 run was performed.
