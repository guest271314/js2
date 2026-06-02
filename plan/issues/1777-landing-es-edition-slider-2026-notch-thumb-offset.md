---
id: 1777
title: "landing page ES edition slider shows ES2026 notch and thumb drifts off ticks"
status: ready
created: 2026-06-02
updated: 2026-06-02
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: landing-page
language_feature: n/a
goal: developer-experience
es_edition: n/a
related: [925, 959, 1201, 1398]
sprint: 59
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
