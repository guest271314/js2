---
id: 1885
title: "Pages deploy regenerates test262-editions.json from stale jsonl → #goals slider shows old numbers"
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
parent: 1880
---

## Problem

Follow-up to #1880. After #1880 committed the correct `test262-editions.json`
(70.8% cumulative) to main, the **live** site at `js2.loopdive.com/#goals`
still showed the old ~65.4% / ES2025 = 61% numbers on the slider — even though
the deploy ran (the served file's `last-modified` was _after_ the merge).

So it was **not** a stale CDN cache: the deploy actively **regenerated**
`test262-editions.json` from a stale input and overwrote the committed fix.

## Root cause

`pnpm build:pages` (`scripts/run-pages-build.mjs`) runs
`scripts/generate-editions.ts` at deploy time. With no `--results` arg, that
script resolves its input in priority order:

1. `.test262-cache/test262-current.jsonl` — absent in the deploy build (gitignored, never fetched there)
2. `benchmarks/results/test262-current.jsonl` — **a stale copy committed on main** (~29,587 pass)
3. `benchmarks/results/test262-results.jsonl`

`deploy-pages.yml` _does_ fetch the fresh baselines-repo jsonl, but copies it to
`website/public/benchmarks/results/test262-results.jsonl` — a path
`generate-editions.ts` does **not** read. So the deploy fell through to the
stale committed `benchmarks/results/test262-current.jsonl` and regenerated the
~65% editions data, clobbering the committed 70.8% file every deploy.

(The donut headline is fetched live from the baselines repo at runtime, so it
correctly showed ~71% — which is why only the slider looked wrong.)

Verified: regenerating from the fresh baselines jsonl yields **30,588 / 43,135 =
70.9%, ES2025 = 72%**, matching the headline.

## Fix

`deploy-pages.yml` — in the "Fetch baseline data" step, also copy the fresh
`/tmp/js2wasm-baselines/test262-current.jsonl` to
`benchmarks/results/test262-current.jsonl` (the `CURRENT_RESULTS_JSONL` input
`generate-editions.ts` actually reads), overwriting the stale committed copy
before `build:pages` runs. The deploy then regenerates editions consistent with
the live headline.

## Acceptance criteria

- [x] After a Pages deploy, `https://js2.loopdive.com/benchmarks/results/test262-editions.json`
      shows the fresh data (cumulative ~70.9%, ES2025 = 72%), matching the donut headline.
- [x] The deploy no longer falls back to the stale committed jsonl.

## Notes / related path-rot (#1656, #1880, #1528)

- The committed `benchmarks/results/test262-current.jsonl` (~29,587 pass) is
  itself stale and, per #1528, should not be committed to main at all. Removing
  it (and relying on the on-demand fetch) would be a cleaner long-term fix, but
  is out of scope here — overwriting it at deploy time is the minimal correct fix.
- #1880 fixed the _promote-baseline_ commit path (which regenerates from a fresh
  per-run jsonl). This issue fixes the _deploy_ regeneration path. Both
  regenerate `test262-editions.json`; they must both read a baseline consistent
  with the headline.
