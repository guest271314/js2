---
id: 1880
title: "ES-edition slider on #goals shows stale ~65% data (CI git-adds pre-#1656 path)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bug
area: website
language_feature: none
goal: dashboard-accuracy
sprint: 59
---

## Problem

On the landing page (`#goals`), dragging the **ES-edition slider** drops the
displayed pass rate from the headline **70.9%** down to **~65.8%** the instant
it leaves the default position — and the per-edition feature section showed
**ES2025 = 61%**, which made the slider look doubly wrong (excluding a
below-average edition should _raise_, not lower, a cumulative rate).

Reported by the user 2026-06-04:

> when i move the es edition slider to 2024 the pass rate drops from 70.9 to
> 65.8 but in the es edition feature section es 2025 has a pass rate of 61% so
> removing it should raise the value not lower it?

## Root cause

The headline donut and the slider read **two different data sources**, and the
slider's source was frozen:

- **Default ("overall") donut** — `website/index.html` fetches the _live_
  baseline `test262-current.json` from the `loopdive/js2wasm-baselines` repo
  (`report.summary`): 30,214 / 43,135 ≈ **70.0%** (≈70.9% on the slightly newer
  live run).
- **Any edition stop** — the `<t262-edition-timeline>` component
  (`website/components/t262-charts.js`) builds `scope.summary` by **cumulatively
  summing** `website/public/benchmarks/results/test262-editions.json`.

That editions file was **stale**: its last data-bearing update was commit
`5d1250a0` (the 2026-05-22 `28842/43159` baseline). Since then the regenerated
file was never committed because of a path break introduced by **#1656**
("consolidate website/frontend files under website/"):

- `scripts/generate-editions.ts` writes to
  `website/public/benchmarks/results/test262-editions.json` (its `OUTPUT_PATH`),
  the vite `publicDir` (`website/playground/vite.config.ts` → `publicDir:
website/public`) that the landing page actually serves.
- But the `promote-baseline` job in `test262-sharded.yml` still did
  `git add -f public/benchmarks/results/test262-editions.json` — the **pre-#1656
  path, which no longer exists**. The `[ -f … ] && git add … || true` guard
  therefore silently no-op'd on every run, so the freshly regenerated file was
  generated and then dropped.
- The baselines-repo push step (`cp benchmarks/results/test262-editions.json …`)
  and `refresh-baseline.yml`'s two git-add blocks had the same stale-path break.

Net effect: the slider's source was pinned at the 2026-05-22 numbers (~65%
cumulative) while the headline kept advancing to ~70.9%, producing the
phantom 5-point cliff. A secondary contributor: ~617 passing tests whose ES
edition can't be classified fall out of the buckets entirely, pulling the
cumulative down further.

**The user's intuition was correct.** With fresh data, ES2025's edition rate is
**72%** (not 61%), and the cumulative is flat across the top editions
(through-2024 70.95%, through-2025 70.97%), consistent with the headline.

## Fix

1. **`test262-sharded.yml`** (`promote-baseline` job): git-add and baselines-repo
   `cp` now target `website/public/benchmarks/results/test262-editions.json`
   (plus the `test262-category-editions.json` sibling generated alongside).
2. **`refresh-baseline.yml`** (both the primary and the rebase-fallback git-add
   blocks): same path correction.
3. **`scripts/generate-editions.ts`**: corrected the stale `public/…` header
   comment to `website/public/…`.
4. **Regenerated** `test262-editions.json` + `test262-category-editions.json`
   from the freshest baseline (`.test262-cache/test262-current.jsonl`, the
   fetched copy of the live baselines-repo jsonl), so the committed data is
   immediately consistent with the live headline (full cumulative excl proposals
   = 30,521 / 43,135 = **70.8%**) instead of waiting for the next full
   `promote-baseline` run.

## Acceptance criteria

- [x] Dragging the ES-edition slider no longer drops the pass rate ~5 points off
      the headline; edition stops hover near the headline (~70.9%).
- [x] The feature-section ES2025 rate is consistent with the cumulative
      behavior (72%, above the running average).
- [x] `promote-baseline` (and the forced `refresh-baseline`) git-add the editions
      JSON at the path `generate-editions.ts` actually writes
      (`website/public/benchmarks/results/`), so the file stays fresh going
      forward.

## Follow-up (out of scope, related #1656 path-rot)

`public/benchmarks/results/{test262-report,test262-standalone-report}.json` are
still tracked as #1656 orphans and are git-added by these same workflows to a
dead directory. They are masked because `index.html` fetches the report live
from the baselines repo, but they should be migrated to `website/public/` (or
removed) in a dedicated cleanup. The `test262-categories.json` baselines-push
line in `test262-sharded.yml` (~L935) may also reference a stale path; not
verified here.
