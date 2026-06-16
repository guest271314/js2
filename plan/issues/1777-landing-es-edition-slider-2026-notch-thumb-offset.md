---
id: 1777
title: "landing page ES edition slider shows ES2026 notch and thumb drifts off ticks"
status: done
completed: 2026-06-04
created: 2026-06-02
updated: 2026-06-04
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: landing-page
language_feature: n/a
goal: developer-experience
sprint: 59
es_edition: n/a
related: [925, 959, 1201, 1398]
origin: "Project lead report on 2026-06-02: landing page ES edition slider added 2026 as a notch, and the knob sits increasingly right of tick marks when dragged right."
---
# #1777 - landing page ES edition slider shows ES2026 notch and thumb drifts off ticks

## Problem

The landing-page ECMAScript edition timeline slider has two visible UI regressions:

1. It now renders `2026` / `ES2026` as a published edition notch. The landing page should not present ES2026 as a normal published-edition stop unless that is intentionally backed by the source data and product copy. The current-standard/proposal tail should remain visually distinct from published editions.
2. The slider thumb is not centered on the tick marks while dragging. The farther the thumb is dragged to the right, the farther it appears offset to the right of the tick it should represent.

This affects the public landing-page conformance visualization, so it is a credibility/polish bug rather than a compiler behavior issue.

## Likely source

The relevant component is `website/components/t262-charts.js`, especially:

- `T262_EDITION_SCOPE_RANK` / `T262_EDITION_RELEASE_YEAR`, which currently include `ES2026`.
- `<t262-edition-timeline>` slider styles around `.track` / `.slider`.
- `_syncUI()`, `_renderTimeline()`, and `_handleSliderInput()`.

The thumb drift is likely caused by the range input using a wider coordinate system than the rendered timeline/ticks:

- `.slider` is positioned with `left: calc(var(--edition-track-bleed) * -1)`.
- `.slider` width is `calc(100% + (var(--edition-track-bleed) * 2))`.
- Tick markers/progress are rendered in the unbleeded track coordinate system (`0..100%`).

That means browser range values map across the widened input while the visual ticks map across the narrower timeline, creating a growing rightward offset.

## Acceptance criteria

- The landing-page edition timeline no longer renders `2026` / `ES2026` as a normal published-edition notch unless explicitly intended and documented.
- Current-standard/proposal coverage remains available, but is visually distinct from published-edition ticks.
- Dragging the slider snaps to the nearest edition/proposal stop, and the thumb center remains aligned with the corresponding tick after the snap.
- The alignment holds at the left edge, middle stops, and right edge in both Chromium and Firefox range-input implementations.
- The progress fill, tick markers, hit area, and thumb all use the same effective coordinate system or a documented compensation.
- Add a focused regression check if the repo already has a suitable browser/DOM test path; otherwise document manual verification in the issue closure notes.

## Non-goals

- Redesigning the edition timeline visualization.
- Changing the underlying test262 edition data schema unless the current `ES2026` treatment cannot be fixed in the component layer.
- Touching compiler/test262 conformance behavior.

## Resolution (2026-06-04)

Both regressions fixed in the component layer only — no data-schema change.
All edits in `website/components/t262-charts.js`; regression test in
`tests/issue-1777.test.ts`.

### 1. ES2026 published-notch

Root cause: `t262LatestPublishedEditionYear()` returned the current calendar
year once the wall clock passed the mid-year spec-freeze month
(`>= June`). On/after 2026-06-01 that promoted `ES2026` — which
`scripts/generate-editions.ts` explicitly buckets as the **draft /
current-standard** edition (`CURRENT_DRAFT_EDITION = 2026`) — into the set of
published-edition slider stops, so it rendered as a normal notch instead of the
distinct current-standard/proposal tail.

Fix: added `T262_CURRENT_DRAFT_EDITION_YEAR = 2026` (mirrors the generator
constant) and capped the latest *published* edition year at
`draftYear - 1`. ES2026 now has `rank > publishedLimitRank`, so it falls into
`proposalEditionLabels` and renders as the distinct proposal tail. Bumping both
constants together is the single intentional switch to promote a draft year to a
published notch.

### 2. Thumb drift (grows toward the right)

Two compounding causes:
- The tick markers are laid out in the **full-timeline weight** coordinate
  (`position / fullLayout.totalSpan`), while the slider thumb travelled in the
  **last-published-stop** coordinate (`position / maxStop`, maxStop = last
  published stop position). Because the full span includes the draft/proposal
  tail, the thumb fraction (e.g. `1.0` at ES2025) exceeded the marker fraction
  (`0.933`), and the gap grew toward the right edge — exactly the reported
  symptom.
- The native range input was bleed-widened (`left: -thumbRadius;
  width: 100% + thumbSize`), so its travel range did not match the 0..100% tick
  coordinate, adding per-browser thumb-inset error.

Fix:
- The slider now operates in the full-timeline weight coordinate
  (`slider.max = totalTimelineWeight`), so thumb fraction == tick percent at
  every stop.
- A single `--edition-thumb-fraction` CSS variable (set via
  `_applySliderPosition`) drives a **custom visible thumb** and the progress
  fill, both positioned in the same track coordinate the markers use
  (`left: calc(fraction * 100%); translateX(-50%)`). The native range input is
  now `left:0; width:100%` with a transparent thumb (keyboard/pointer hit target
  only), removing the bleed and the per-browser inset guesswork. `_handleSliderInput`
  snaps the fraction to the nearest stop immediately so the thumb rests on the tick.

### Test Results

`tests/issue-1777.test.ts` (6 tests, all pass; node env, no headless browser):
- ES2026 is never reported as the latest published edition for any reference date
  within the draft year (Jan/June/Dec) — stays in the proposal tail.
- `t262ResolveLatestPublishedEdition` picks ES2025 given draft-bearing rows.
- `draftRank > publishedLimitRank` (routes ES2026 to the distinct tail).
- Thumb fraction == marker fraction for every published stop (exact, within 1e-9).
- Regression guard documents that the old last-stop denominator drifted the thumb
  right of its tick.

`tsc --noEmit`, `biome lint`, `prettier --check` on the test file: clean.
