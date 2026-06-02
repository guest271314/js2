---
id: 1773
title: "generate dependency graph data in CI and publish to labs"
status: done
created: 2026-06-01
updated: 2026-06-01
completed: 2026-06-01
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: ci
goal: platform
sprint: 58
related: [1067, 1616, 1771]
origin: "Project lead feedback after repeated website/public/graph-data.json merge conflicts."
---
# #1773 - generate dependency graph data in CI and publish to labs

## Problem

`website/public/graph-data.json` is a large generated dependency-graph artifact.
Keeping it tracked in `loopdive/js2` creates noisy merge conflicts whenever
several sprint branches touch planning files.

The Pages build already regenerates the graph data before packaging
`website/public/`, so source control should track the inputs and workflow, not
the generated JSON snapshot.

## Acceptance

- `website/public/graph-data.json` is ignored and removed from the public repo's
  tracked files.
- `pnpm build:pages` still regenerates the graph data before the Pages artifact
  is built.
- The deploy workflow publishes the generated snapshot to
  `loopdive/js2wasm-labs` so the artifact remains available outside the public
  source tree.
- Planning changes no longer produce `graph-data.json` merge conflicts in
  ordinary PRs.

## Implementation notes

- Added `website/public/graph-data.json` to `.gitignore` and removed it from
  the index.
- Kept the existing `build:pages` path: `scripts/run-pages-build.mjs` invokes
  `scripts/build-planning-artifacts.mjs`, which invokes
  `plan/generate-graph.ts`, before Vite copies `website/public/`.
- Added a `deploy-pages.yml` step that copies the generated graph snapshot to
  the `labs/graph-data` branch of `loopdive/js2wasm-labs` when
  `LABS_DEPLOY_KEY` is configured.
