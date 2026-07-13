---
id: 3072
title: "Fix <t262-donut> layout: orbit labels too high (desktop), glow clipped (mobile), legend centering"
status: done
assignee: ttraenkler/donut-layout
sprint: 71
created: 2026-07-06
updated: 2026-07-13
completed: 2026-07-06
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: chore
area: website
language_feature: n/a
goal: developer-experience
---

# #3072 — `<t262-donut>` layout fixes

Three CSS/layout issues in the `<t262-donut>` web component
(`website/components/t262-charts.js`), reported by the project lead viewing the
live site (landing page + report page).

## Problems

- **(A) — MOST IMPORTANT.** On desktop the orbit labels (Passed / Failed /
  Compile Errors / Skipped) sit slightly TOO HIGH and don't align with the
  donut ring.
- **(B).** On mobile the donut's glow is clipped at the bottom.
- **(C).** On desktop the "legend" looks offset — but on desktop the legend is
  `display:none` and the orbit-stats ARE the labels, so (C) is the same vertical
  offset as (A). Also sanity-check the `<440px` legend centering.

## Root cause (A)

The orbit-stat labels are positioned as children of `.gauge-orbit` with inline
`left:50%;top:50%` plus `transform: translate(calc(-50% + labelDx), calc(-50% +
labelDy))`, where `labelDy = lp.y - centerY = sin(angle)*radius` (the `centerY`
constant CANCELS in the delta). So the labels orbit the geometric center of
`.gauge-orbit` (its 50%,50% = y=190). BUT the ring does NOT sit at that center:
`.gauge-core { inset: 45px 0 0 }` pushes the ring DOWN by half the top inset
(≈22.5px) → ring center is at y=212.5, not 190. Net: labels orbit ~22.5px above
the ring → "too high". The stale comment/`centerX,centerY` constants still
described the old 380×320 geometry (`centerY=182`) after the box grew to
380×380.

## Root cause (B)

On `@media (max-width:440px)` the orbit box is 280px tall (300px padding box,
height 280 + padding-top 20) with orbit-stats hidden. But `.gauge-core` still
carried the 45px top inset, so the 250px ring centered at y=172.5 (bottom at
297.5). The `.gauge-glow` (`inset:-8px` + `blur(6px)`, ≈14px bleed) reached
~311px — past the 300px box — and was clipped by `:host { overflow: clip }`.

## Fix

- Introduced a single source of truth: `--_donut-top-inset: 45px` on `:host`,
  used BOTH by `.gauge-core { inset: var(--_donut-top-inset) 0 0 }` AND by the
  orbit-stat anchor.
- (A) Orbit-stat inline `top:50%` → `top: calc(50% + (var(--_donut-top-inset) /
  2))` (190 + 22.5 = 212.5 = ring center). `left:50%` unchanged (ring is already
  horizontally centered). Updated the stale comment + `centerY` (182 → 212.5) so
  the constants match the real ring center (they feed collision detection via
  absolute `lp` positions).
- (B) Inside the mobile media query, override `.gauge-orbit {
  --_donut-top-inset: 0px }`. Orbit labels are hidden on mobile, so the inset is
  unneeded; zeroing it centers the 250px ring in the 300px box (~25px above and
  below), so the ≈14px glow bleed renders fully instead of being clipped. Scoped
  to the media query — desktop overflow protection is untouched.
- (C) On desktop, (A)'s fix resolves the perceived "legend offset" (legend is
  `display:none` ≥440px; orbit-stats are the labels). For `<440px`, constrained
  `.legend` to `max-width:320px` + `margin-inline:auto` so the two-column legend
  centers under the donut instead of stretching the full host width.

## Geometric justification (A)

`.gauge-orbit` padding box = height 360 + padding-top 20 = 380 tall; width 380.
- Orbit anchor: `left:50%` = 190; `top: calc(50% + topInset/2)` = 190 + 22.5 =
  212.5.
- Ring center: `.gauge-core` top = 45, bottom = 0 → height 335 → 250px ring
  centered at 45 + 335/2 = **212.5**.
- Anchor (190, 212.5) == ring center (190, 212.5), and `centerX,centerY` =
  (190, 212.5) == anchor, so each label's delta `(lp - center)` lands it exactly
  on its computed orbit point on the ring.

## Verification

- `node --check` passes; `tests/issue-1777.test.ts` (the module's unit tests)
  pass.
- No browser in the container → pixel-level visual confirmation is deferred to
  the deployed site (lead to eyeball desktop + mobile after deploy). Correctness
  argued geometrically above.
