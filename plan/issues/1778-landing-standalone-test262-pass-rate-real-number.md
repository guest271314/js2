---
id: 1778
title: "landing page JS-host toggle should show real standalone test262 pass rate"
status: ready
created: 2026-06-02
updated: 2026-06-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: landing-page
language_feature: n/a
goal: developer-experience
es_edition: n/a
related: [925, 959, 1201, 1583, 1662, 1777]
sprint: 58
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
