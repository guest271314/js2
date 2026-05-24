---
id: 1656
title: "Consolidate all website/frontend files under website/"
status: ready
sprint: 55
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: website, build, ci
related: [1583, 1590]
---

# Consolidate all website/frontend files under website/

## Problem / goal

Website and frontend assets are scattered at the repo root, mixed in with the
compiler sources and project tooling. A new contributor opening the repo root
cannot tell at a glance what is the compiler and what is the marketing/docs/
playground site.

Consolidate all website/frontend files into a single top-level `website/`
directory so the repo root cleanly separates **the compiler** (`src/`,
`tests/`) from **the site**. After the move, the root should contain no loose
site files; everything the site needs lives under `website/`.

This is a structural refactor only — no behavior change. The site must still
build and deploy exactly as before, and the dashboard must still read the
benchmark results it depends on.

## In scope — move under `website/`

All verified present at the repo root on `main`:

- `components/`
- `dashboard/`
- `playground/`
- `index.html`
- `public/`
- `frame-nav-sync.js`
- `playground.png`
- `screenshot.png`
- `vite.config.ts` — the **site/playground** build config. NOT
  `vite.config.lib.ts` (that builds the compiler library bundle and stays at
  root).
- `CNAME` — GitHub Pages custom domain (`js2.loopdive.com`). Verify whether
  Pages requires it at the Pages-source/artifact root and move/place it
  accordingly so the custom domain survives.

## NOT in scope (stay at root)

`src/`, `tests/`, `scripts/`, `plan/`, `benchmarks/` (benchmark harness — its
`results/` feed the dashboard but the directory stays at root), `examples/`,
`docs/`, `packages/`, `spec-compliance/`, `test262/`, all dotfiles,
`package.json`, `vite.config.lib.ts`, `vitest.config.ts`, `tsconfig.json`, and
all top-level markdown (README / CONTRIBUTING / etc.).

## Build / CI surface that MUST be updated as part of the move

This is why the issue needs an architect implementation spec before any dev
touches it: the move is mechanically simple but the path/config fan-out is
wide, and getting any one of these wrong silently breaks the deployed site.

- `vite.config.ts` — `root`, `publicDir`, `build.outDir`, and input paths
  (the site config likely references `index.html`, `playground/`,
  `dashboard/`, `components/` relative to its own location).
- `package.json` scripts — `dev`, `build:playground`, `dashboard:watch`,
  `build:pages`, and anything else that references `index.html`,
  `playground/`, `dashboard/`, or `components/`.
- `scripts/build-pages.js` — the GitHub Pages build; audit all path
  assumptions (input dirs, copy globs, output dir).
- `.github/workflows/deploy-pages.yml` — the Pages publish source / artifact
  upload path.
- `CNAME` placement — must end up wherever the Pages artifact root is so the
  custom domain (`js2.loopdive.com`) is preserved.
- All import / asset paths **inside** `components/`, `dashboard/`, and
  `playground/` that reference each other or root-relative assets
  (e.g. `dashboard/data*.js`, `components/*.js`, relative `../public/...`
  references, `<script src>` / `import` paths in `index.html`).

## Acceptance criteria

- All listed files live under `website/`; the repo root no longer has loose
  site files.
- `pnpm run build:playground` succeeds from the new layout.
- `pnpm run build:pages` succeeds from the new layout.
- GitHub Pages still deploys and the CNAME / custom domain
  (`js2.loopdive.com`) is preserved.
- No broken import / asset paths; the dashboard still reads its benchmark
  results from `benchmarks/results/`.

## Notes

- **Needs an architect implementation spec BEFORE a dev executes it.** The
  spec must enumerate: the exact move list (every path, old → new), every
  config/script/workflow edit with the precise key/line changed, every
  internal import/asset path rewrite, and a verification plan
  (`build:playground`, `build:pages`, and a check that the Pages artifact
  carries `CNAME`).
- This should land as **one PR** (a single coordinated move) — splitting the
  move from the path/config edits leaves `main` in a broken-build state.
- Tracked in the TaskList as `arch(#1656)`.
- Related: #1583 (landing feature-support table audit), #1590 (first-5-min UX
  docs) both touch the same frontend surface — sequence so this consolidation
  lands without colliding with in-flight site edits.
