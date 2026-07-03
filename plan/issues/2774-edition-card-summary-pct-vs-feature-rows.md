---
id: 2774
title: Landing-page edition card summary % doesn't reconcile with its feature rows
status: done
sprint: 69
priority: low
horizon: s
feasibility: easy
completed: 2026-06-28
---

## Problem

On the landing page (`website/index.html`, "Goal: 100% ECMAScript
compatibility" section), each ES-edition feature card shows a **summary
percentage** in its header alongside a list of **individual feature rows**,
each with a live `pass / total` count. The header `%` does not reconcile with
the per-feature rows — summing the rows never reproduces the header number,
which reads as a bug to visitors.

## Root cause (not an arithmetic bug)

The header `%` and the per-feature rows are computed from **two different
datasets over two different populations**, so by construction they cannot sum:

1. **Different populations (dominant).** The header aggregates *every* Test262
   test classified into that edition; the rows only cover the curated subset of
   features actually listed in the card. Most edition tests are not represented
   by any visible row.
   - Header: `website/index.html` `updateEditionPassBars` →
     `loadEditionBuckets()` → `benchmarks/results/test262-editions.json`
     (built by `scripts/generate-editions.ts`).
   - Rows: `hydrateFeatureBadges` → `feature-examples.json` per-feature
     `passCount` / `totalCount`.

2. **Different classification axis.** Editions bucket by test **frontmatter**
   (`es5id` / `es6id` / `features` tags, `generate-editions.ts:395-449`); rows
   bucket by **file-path prefix** (`data-t262-paths`). The same test is
   attributed to different editions by each axis — e.g. the "ES3 / Core" card's
   path-matched rows pull 2,804 tests, but only 274 tests carry ES3-era
   frontmatter.

3. **Skip handling differs.** Header `pct = pass / (pass+fail+ce+skip)`
   (`generate-editions.ts:601,612`, skip in denominator); per-feature
   `total = pass+fail+ce` (skip excluded).

A naive "Other = header − Σ(rows)" remainder row was evaluated and **rejected**:
it produces negative remainders on the most prominent cards (ES3 −2,530,
ES5 −1,526, ES2015 −1,029) precisely because of axis #2.

## Fix (option B — relabel, display-only)

Make the framing honest rather than forcing the two numbers to reconcile:

- The edition header passbar now renders the **edition-wide `pass / total`
  count** next to the `%` (the population the `%` is actually measured over).
- A disclaimer above the cards states the percentage/count cover **every**
  Test262 test in the edition, and the feature rows are **illustrative
  examples**, not a complete breakdown, so their counts are not meant to sum to
  the edition total.

All changes are display-only in `website/index.html`; no data regeneration.

## Acceptance criteria

- [x] Edition card header shows the edition-wide `pass / total` count beside the `%`.
- [x] A visible note clarifies the rows are illustrative and don't sum to the header.
- [x] `node scripts/derive-feature-badges.mjs --check` passes (no `feat-row` changed).
- [x] `prettier --check website/index.html` passes.

## Out of scope (follow-ups)

- Several cards (ES2019 / ES2022 / ES2024) have curated rows whose `.feat-name`
  matches **nothing** in `feature-examples.json`, so they show blank `N / T`
  chips today. Pre-existing, independent of this relabel.
