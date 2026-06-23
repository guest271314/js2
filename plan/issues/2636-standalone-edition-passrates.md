---
id: 2636
title: "Landing page shows no standalone pass rate for ES editions other than the latest"
status: done
sprint: Backlog
feasibility: medium
completed: 2026-06-24
---

## Problem

On the landing page, the conformance donut has a **JS host / standalone**
toggle and an ES-edition slider. With the toggle set to **standalone** (JS host
OFF), selecting any specific edition (ES5, ES2015, … ES2025) rendered
**"Unavailable"** — only the *overall* (latest/all) standalone number showed.
The JS-host path showed every edition fine.

## Root cause

Asymmetric data sources for per-edition data:

- **JS-host** editions come from a dedicated `test262-editions.json`, built by
  `scripts/generate-editions.ts` from the host baseline JSONL and consumed by
  the edition-timeline component.
- **Standalone** editions were expected *inline* in the standalone report JSON
  (`report.edition_summaries` / `standalone_edition_summaries`, read by
  `getStandaloneEditionSummary` in `website/index.html`). But
  `scripts/build-test262-report.mjs` never emits any per-edition breakdown into
  the standalone report — only headline + scope (`standard`/`annex_b`/`proposal`)
  summaries. So every per-edition standalone lookup returned `null` →
  "Unavailable".

The runner result records carry no edition field; edition classification needs
test262 frontmatter, which only `generate-editions.ts` does.

## Fix

Mirror the host editions mechanism for the standalone lane:

1. **`scripts/run-pages-build.mjs`** — after the host `generate-editions.ts`
   pass, fetch the standalone baseline JSONL (`fetch-baseline-jsonl.mjs
   --standalone`) and run the *same* classifier over it to emit
   `website/public/benchmarks/results/test262-standalone-editions.json`.
   Best-effort: an offline build or baseline outage skips it (keeps the
   committed copy / "Unavailable") instead of failing the Pages build.
2. **`.github/workflows/deploy-pages.yml`** — pre-place the standalone baseline
   JSONL from the already-cloned baselines repo into `.test262-cache/` so the
   deploy regenerates from FRESH data (the idempotent fetch then no-ops).
3. **`website/index.html`** — reader fetches the standalone editions file
   (memoised), keys it by normalized edition label, and `getStandaloneSummary`
   falls back to those buckets when the report lacks edition data. Strict-mode
   per-edition standalone numbers are approximated by scaling the bucket by the
   standalone strict/overall ratio (same approach the host path uses).
4. Committed an initial `test262-standalone-editions.json` (generated from the
   current standalone baseline) so the toggle has data immediately, mirroring
   the committed host `test262-editions.json`.

`generate-editions.ts` itself was unchanged — it already accepts
`--results`/`--output`, and its category-editions side-output is skipped for the
standalone output name (regex guard), so no stray file is written.

## Verification

- `generate-editions.ts` over the standalone baseline produces 15 edition
  buckets (≤ES3 … ES2026 + Proposals) with real pass/fail/ce/skip/total.
- Reader edition-lookup simulation resolves every edition to real standalone
  numbers (ES2015 50.4%, ES2018 63.5%, ES5 55.9%, ES3/Core 79.9%, …) and a
  nonexistent edition still returns "Unavailable".
- All inline `<script>` blocks parse; `biome lint scripts` clean.
