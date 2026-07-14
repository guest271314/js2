---
id: 3260
title: "Whitepaper: auto-update Test262 conformance numbers + date from the authoritative baseline at build time"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: easy
task_type: chore
area: website, ci
goal: ir-full-coverage
created: 2026-07-14
related: [1147, 1216]
origin: "whitepaper hardcodes 73.5% / 31,700 / 'As of May 2026' — already stale vs live 76.5% / 32,990 (2026-07-14)"
---

# #3260 — Whitepaper conformance numbers + date must auto-update

## Problem

`website/docs/whitepaper.md` and `website/docs/whitepaper.html` **hardcode** the
Test262 conformance figures and a date, so they silently rot as the real number
climbs. As of 2026-07-14 the whitepaper says:

- "**73.5% Test262 compliance**" (line 16, 216, 320)
- "**31,700 / 43,106** official conformance tests passing" (line 216)
- "**As of May 2026**, we are not aware of another AOT JavaScript-to-Wasm…" (line 273)

…but the authoritative baseline (`benchmarks/results/test262-current.json`,
refreshed by the `promote-baseline` job on every push to main) already reads
**76.5% — 32,990 / 43,106** (generated 2026-07-14). The doc is ~1,300 tests /
3 percentage points stale and the date is two months old. This is exactly the
kind of number a public whitepaper must not get wrong.

Root cause: `scripts/build-pages.js:256` **copies `whitepaper.html` verbatim** —
there is no build-time substitution of live figures, and the `.html` is
maintained by hand alongside the `.md`.

## Authoritative source (already in-repo, already CI-refreshed)

`benchmarks/results/test262-current.json` (committed, ~kB, updated every push to
main by `test262-sharded.yml`'s `promote-baseline`):

```
official_summary.pass   = 32990
official_summary.total  = 43106      // → 76.5%
baseline_generated_at   = "2026-07-14T00:12:41.734Z"
baseline_sha            = "4bc8763166…"
```

## Scope

1. **Tokenize** the conformance figures + date in `whitepaper.md` (and `.html`)
   with placeholders, e.g. `{{TEST262_PCT}}`, `{{TEST262_PASS}}`,
   `{{TEST262_TOTAL}}`, `{{REPORT_DATE}}` (and drop the brittle "As of May 2026"
   in favour of the generated date, or a plain relative phrasing).
2. **Inject at build time** in `scripts/build-pages.js`: read
   `benchmarks/results/test262-current.json`, compute
   `pct = round(pass/total*100, 1)`, format `pass`/`total` with thousands
   separators and `baseline_generated_at` as a human date, and substitute the
   tokens when emitting `PAGES_DIST/docs/whitepaper.{html,md}`. Keep the source
   files carrying the tokens (not baked numbers) so they never re-stale.
3. Decide the `.html`↔`.md` relationship: either (a) generate the `.html` from
   the `.md` at build (preferred — single source), or (b) run the same token
   substitution over both. Do NOT leave two hand-maintained copies with baked
   numbers.
4. Since `promote-baseline` already re-commits the baseline JSON and
   `deploy-pages` rebuilds on every push to main (#1216), the whitepaper then
   tracks the live number automatically — **no separate cron needed.**

## Acceptance

- `whitepaper.{md,html}` source contains tokens, not baked figures/date.
- `scripts/build-pages.js` substitutes live values from
  `benchmarks/results/test262-current.json`; the built page shows the current
  number (76.5% / 32,990 / 43,106) and the baseline's generation date.
- A stale-guard: a quick check (unit or `build:pages` assertion) that fails if a
  bare `NN.N% Test262` or `As of <Month> 2026` literal reappears in the source,
  so the rot can't silently return.
- Rebuild is idempotent and wired to the existing deploy-pages flow (no new cron).

## Non-goals

- No redesign of the whitepaper content/prose beyond the tokenized figures+date.
- Not touching the benchmark/perf sidebar (`playground-benchmark-sidebar.json`,
  already auto-refreshed by #1216) — this issue is only the whitepaper's
  conformance figures + date.
