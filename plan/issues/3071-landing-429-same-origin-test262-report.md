---
id: 3071
title: "Landing page hammers rate-limited raw.githubusercontent for test262 baseline (429) — prefer same-origin"
status: done
sprint: 71
priority: high
horizon: s
assignee: ttraenkler/agent-afc849ea5d2483a25
completed: 2026-07-06
---

## Problem

The landing page (`website/index.html`) fetches the test262 baseline JSON
DIRECTLY from `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/...`
at five sites. `raw.githubusercontent.com` rate-limits and returns HTTP 429
("Failed to load resource: 429") under normal visitor traffic, which
intermittently breaks the conformance donut / headline stats.

Identical, equally-fresh same-origin copies are already deployed to the Pages
site:
- JS-host: `./benchmarks/results/test262-report.json` (schema identical to the
  raw `test262-current.json`: `summary`, `full_summary`, `strict_summary`,
  `scope_summaries`, `categories`).
- standalone: `./benchmarks/results/test262-standalone-report.json` (already a
  fallback today).

## Fix

Fetch the same-origin copy FIRST at all five sites; keep the raw
`raw.githubusercontent.com` URL as a resilience fallback everywhere.

Sites changed in `website/index.html`:
1. `<t262-donut src=...>` markup attribute → `./benchmarks/results/test262-report.json`.
2. `hydrateCompatibilityStat` fetch → shared `fetchTest262ReportJson()` helper (same-origin first, raw fallback).
3. `STANDALONE_TEST262_REPORT_URLS` array reordered so the same-origin standalone report is first, raw is fallback.
4. Main JS-host donut fetch → `fetchTest262ReportJson()`.
5. `hydrateFeatureCoverage` fetch → `fetchTest262ReportJson()`.

A single shared helper `fetchTest262ReportJson(urls = JSHOST_TEST262_REPORT_URLS)`
is defined at the top of the page's main `<script>` and tries the URLs in order,
returning the first `ok` JSON and throwing only if all fail. URLs stay relative
(`./benchmarks/results/...`) so they resolve against the dynamic `<base href>`
(loopdive.github.io/js2wasm vs js2.loopdive.com vs local dev).

## Freshness

`test262-report.json` does NOT go stale: `.github/workflows/deploy-pages.yml`
(the "materialize baselines" step) sparse-clones `loopdive/js2wasm-baselines`
and copies `test262-current.json` → `website/public/benchmarks/results/test262-report.json`
on every Pages deploy — the SAME source the raw URL points at.
`scripts/build-pages.js` then copies it into the Pages dist. So the same-origin
copy is regenerated from the identical baseline on each deploy; preferring it
over the raw URL changes only the fetch host, not the data.

## Validation

- Same-origin 200 → primary path renders donut from `test262-report.json`.
- Same-origin 404/network error → helper falls through to raw
  `test262-current.json`; standalone loop falls through to the raw standalone URL.
- `grep raw.githubusercontent.com website/index.html` → only the two fallback
  occurrences remain (JS-host helper + standalone array); no bare raw fetch.
