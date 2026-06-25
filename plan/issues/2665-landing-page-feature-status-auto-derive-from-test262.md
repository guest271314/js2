---
id: 2665
title: "dashboard: landing-page feature-support labels are hardcoded HTML, not auto-derived from test262 pass-rates (with/SAB/top-level-await/__proto__ etc. shown permanently 'not supported')"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: medium
feasibility: medium
task_type: bug
area: dashboard, website
goal: spec-completeness
sprint: 66
---

# #2665 — landing-page feature status must auto-derive from test262, not hardcoded HTML

## Problem (user-reported 2026-06-25)

The landing page (`website/index.html`) hand-codes per-feature support labels as
static prose/markup — e.g. line ~1857 `<pre>with (obj) { x; } // not supported</pre>`,
line ~2582 `new SharedArrayBuffer(1024); // not supported`, top-level-await
"Not yet supported", growable buffers "not yet supported", `__proto__` "not
supported", arguments "partially supported", RegExp "partially supported",
defineProperty "partially supported". These are **not derived from test262
results**, so:
- A feature reads "not supported" / "won't be supported" even when partial
  support exists or could be measured (e.g. `with` Tier-1 static shipped in
  #1387; see #2663 for Tier-2).
- The labels go stale silently — they never reflect the live pass-rate.

The per-feature DETAIL page (`website/public/benchmarks/feature-report.html`)
already does the right thing: it reads `passCount`/`totalCount`/`tests[]` from
`feature-examples.json` (augmented by `dashboard/build-data.js`) and shows a
live pass-rate. The LANDING-page catalog does not.

## Goal

Make every feature-support label in the landing-page catalog **auto-derive from
the corresponding test262 category pass-rate** (the same `feature-examples.json`
data the detail page uses), with a status threshold (e.g. ≥90% supported / ≥1%
partial / 0% not-yet — TBD), so labels update automatically on every
baseline refresh. Remove the hardcoded "not supported" / "won't be supported"
strings.

## Scope

1. Identify the canonical data: `feature-examples.json` (build-data.js) — each
   feature card on the landing page maps to one or more test262 `testCategories`.
2. Wire each landing-page feature card to its category pass-rate — either a
   build-time injection (preferred; the page is currently static HTML) or a
   client-side fetch+render of the support badge. Decide the approach.
3. Define the status thresholds (supported / partial / not-yet) and render a
   live badge + pass-rate, replacing the hardcoded prose label.
4. **AUDIT all features in these lists** (the user explicitly asked): enumerate
   every hardcoded support label in `website/index.html` (and any sibling list
   in `spec-compliance.html` / dashboard), confirm each now derives from its
   test262 category, and flag any feature with no mapped category (those need a
   category mapping or an explicit, justified manual status).
5. Keep prose EXPLANATIONS (the "why / how to work around it" text) but the
   support STATUS must be data-driven.

## Acceptance

- No hardcoded support-status strings remain in the landing-page catalog; every
  feature badge reflects its live test262 pass-rate.
- `with` shows its actual Tier-1 pass-rate (and updates when #2663 Tier-2 lands)
  rather than a static "not supported".
- An audit note in this issue lists every feature card → test262 category it now
  derives from (and any unmapped ones).

## Notes

- This is dashboard/website work (not core compiler) — dev-claimable.
- Coordinate the status-threshold definition so it's consistent with
  `spec-compliance.html`'s existing conforming/partial/not_implemented scheme.
