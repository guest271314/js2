---
id: 2910
title: "Editions dashboard: classify feature rows by `features:` frontmatter (edition-sliced) so they reconcile with the section headline"
status: ready
priority: medium
sprint: current
created: 2026-07-01
feasibility: medium
task_type: enhancement
area: tooling
goal: developer-experience
related: [2774, 977, 2636, 959]
---

# #2910 — reconcile edition feature rows with the section headline (frontmatter-based, edition-sliced)

## Problem
On the landing page, an ES-edition section shows a **headline pass %/count**
and a list of **feature rows**, each with a `pass / total`. They don't
reconcile — a section at 100% can still show feature rows below 100%, and the
rows never sum to the headline. #2774 (done) diagnosed this but chose a
**display-only relabel** (a disclaimer + "illustrative examples") rather than
fixing the underlying axes. This issue does the real fix.

## Root cause (from #2774)
Headline and rows are computed over **different populations via different axes**:
- **Headline** — tests classified into the edition by **frontmatter**
  (`es5id`/`es6id`/`esid`/`features`) — for ≤ES3 that's **274** tests
  (`test262-editions.json` ← `scripts/generate-editions.ts`).
- **Rows** — tests matched by **file-path prefix** (`data-t262-paths` →
  `feature-examples.json`) — the "ES3/Core" card's path-glob pulls **~2,804**
  tests, a different and much larger set.
- Plus inconsistent **skip handling** (headline `pass/(pass+fail+ce+skip)`;
  rows `pass+fail+ce`).

Because the row population is not a subset of the headline population,
"section 100% ⇒ rows 100%" cannot hold.

## Accurate classification (the fix)
Derive **both** axes from the same authoritative per-test frontmatter:

**FEATURE** = the test's `features:` tags (test262's canonical,
maintainer-assigned, validated against `features.txt`). NOT file path. A test
can carry several features (many-to-one). Tests with no `features:` tag
(ES3/ES5-era) are "core language" — see the ES3 note.

**EDITION** = the **newest** thing the test requires:
1. `features:` → map each tag to its **introduction edition** via the existing
   `FEATURE_EDITION` table (`generate-editions.ts:54`) and take the **max**.
2. else `es6id` → ES2015; `esid` → ES2015+.
3. else `es5id` → ES5.
4. else → ≤ES3.

**Reconciliation** — compute the feature rows over the same population as the
headline, **sliced within each test's single edition**:
- Each test → exactly one edition (its max-feature/es-id edition).
- A feature row under edition *E* = `{ tests assigned to E that carry this
  feature tag }` — a strict **subset** of *E*'s headline population.
- Use **one** skip convention for both.
- Then row ⊆ headline population ⇒ section 100% ⇒ every feature row 100%. ✓

## Two irreducible properties (document in the UI, don't fight them)
1. **Rows still won't *sum* to the headline** — a multi-feature test appears in
   several rows within its edition, so rows overlap. Present as "slices," not a
   stacked/summing breakdown. (This is correct — features aren't a partition.)
2. **ES3/"core" has no feature axis** — those tests predate `features:`. For
   that one edition, either show only the headline (no feature rows) OR build a
   small **hand-curated** core-language grouping (operators, control flow,
   `arguments`, prototype chain, …) mapped to **explicit test lists** — a manual
   mapping, NOT a path-glob, so it stays a true subset of the 274.

## Implementation plan
1. **`scripts/generate-editions.ts`** — extend the per-test classification so it
   emits, per edition, the feature-sliced `pass/total` counts (group each
   edition's tests by their `features:` tags; a test contributes to each of its
   feature rows within its assigned edition). Reuse `classifyEdition` +
   `FEATURE_EDITION`; keep the edition assignment single (max).
2. Emit a new/extended `test262-editions.json` shape carrying
   `editions[].features[] = { name, pass, total }` (edition-sliced), replacing
   the path-glob `feature-examples.json` counts as the row source.
3. **Feature-examples pipeline** (`scripts/generate-feature-examples.ts` +
   `feature-examples.json`) — keep the curated *example code snippets* per
   feature, but source the `passCount/totalCount` from the new edition-sliced
   data (by `features:` tag), not `data-t262-paths`. Keep the example-path list
   for the code sample only, not for counting.
4. **`website/index.html`** — `hydrateFeatureBadges` reads the reconciled
   per-feature counts; `updateEditionPassBars` unchanged. Retire the #2774
   disclaimer once the numbers reconcile (or soften it to only the
   rows-don't-sum + ES3-core caveats above).
5. **ES3 core mapping** — add the curated core-language groups → explicit test
   lists (or omit rows for ≤ES3 and show only the headline). Decide with the PO.
6. Consistent **skip** convention across headline + rows.

## Acceptance
- For any edition at 100%, every feature row in that section reads 100%.
- Each test is assigned to exactly one edition; feature rows are subsets of
  their edition's headline population (verifiable: no row `total` exceeds its
  edition `total`).
- ES3 section shows either just the reconciled headline or a curated core-list
  breakdown (no path-glob), never the ~2,804 phantom population.
- `pnpm run build:pages` regenerates the data; landing page renders without the
  reconciliation disclaimer (or with only the two documented caveats).
