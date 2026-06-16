---
id: 2156
title: "Unify the two wasm-treemap implementations (playground .ts vs standalone .html)"
status: backlog
sprint: Backlog
created: 2026-06-15
updated: 2026-06-15
priority: low
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: website
language_feature: tooling
goal: process
related: [2155]
origin: "Surfaced while fixing #2155/GH #1465 — the same component-handling fix had to be implemented twice"
---

## Problem

The wasm-treemap tool exists as two independent copies that duplicate ~600
lines of parser + tree-building + rendering logic:

- `website/playground/wasm-treemap.ts` — ESM module (requires the vite build),
  exports `parseWasm` and the `WasmTreemap` widget class.
- `website/public/wasm-treemap.html` — a **zero-build, self-contained** single
  file in `public/` (copied verbatim, no bundling). Its inline `<script>`
  reimplements the same logic as global functions. This is the page the #1465
  reporter used ("drop a file on the site").

`parseWasm`, `parseComponent`, `buildSectionsTree` / `addModuleSections`,
`buildFunctionsTree`, `squarify`, `renderNode`, `applyRemainders`, the LEB
decoders, etc. are all duplicated. #2155 (GH #1465) is direct evidence of the
maintenance cost: the identical Component-Model fix had to be written into both
files, and any future treemap change risks the two drifting.

## Why it wasn't done inline with #2155

Unifying is a structural change, not a bugfix, and there's a real tradeoff:

- The standalone HTML is deliberately a single openable/hostable artifact with
  **no build step**. Making it load the bundled `.ts` module couples it to the
  vite pipeline (it stops being "open the raw file").
- Touching the HTML at all triggers the repo's save-hook Prettier pass, which
  reformats the whole (previously non-Prettier-clean) file — mixing that with a
  behavior change is poor PR hygiene.

So #2155 fixed both copies to actually resolve the issue, and deferred the
dedup here.

## Proposed approach

Make `wasm-treemap.ts` the single source of truth (parser + `WasmTreemap`
widget) and have the standalone page consume it. Options to evaluate:

1. **Build a standalone bundle**: add a vite entry that emits a self-contained
   `wasm-treemap.js` (or an inlined single-file HTML) which the deployed
   `/wasm-treemap.html` loads. The hand-maintained `public/` inline script is
   deleted. (Preferred — true single source; the "standalone" property becomes
   a build output rather than a hand-kept file.)
2. **Template the HTML at build time** from the TS source (codegen the inline
   script). Keeps a single emitted file but adds build machinery.

## Acceptance criteria

- One implementation of the parser/tree/render logic; no duplicated `parseWasm`
  / tree-builders.
- The deployed standalone treemap page still works (drag-drop a `.wasm`/`.wat`,
  `?url=` param, sections/functions toggle, component drill-down from #2155).
- The playground treemap is unchanged for the user.
