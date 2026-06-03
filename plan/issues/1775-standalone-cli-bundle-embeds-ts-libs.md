---
id: 1775
title: "standalone CLI bundle embeds TypeScript lib declarations"
status: done
created: 2026-06-01
updated: 2026-06-01
completed: 2026-06-01
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: tooling
language_feature: packaging
goal: platform
sprint: 58
es_edition: n/a
related: [986, 1757, 1763]
origin: "Follow-up from GitHub #986 comments about moved Bun/Deno standalone bundles looking for node_modules/typescript/lib."
---
# #1775 - standalone CLI bundle embeds TypeScript lib declarations

## Problem

GH #986's original `require("binaryen")` bundling failure is fixed by the async
optimizer path (#1757/#1763), but the standalone executable flow still has a
second portability gap: TypeScript lib declarations are read from
`node_modules/typescript/lib` at runtime unless the embedding environment
preloads them.

That means a single-file `js2wasm.js` bundle can compile while it remains next
to `node_modules`, then fail or degrade after it is moved to another filesystem
or compiled with `deno compile`.

## Scope

- Provide a supported CLI bundle build command for relocatable executable
  workflows.
- Inject the TypeScript `lib.*.d.ts` files into the generated bundle at build
  time using the existing `__js2wasmTsLibFiles` hook.
- Avoid relying on `package.json` at runtime for `--version` in the generated
  bundle.
- Keep the normal npm library build unchanged for TypeScript, while treating
  Binaryen as an optional optimizer dependency instead of a required compiler
  dependency.

## Acceptance

- `pnpm run build:standalone-cli` writes `dist/js2wasm-standalone.mjs`.
- The generated bundle preloads TypeScript lib declaration text and can be
  moved away from `node_modules`.
- `--version` in that bundle uses an injected package version rather than
  `createRequire("../package.json")`.
- Regression coverage checks both lib-file prelude generation and the public
  `preloadLibFiles()` path under a no-filesystem environment.

## Implementation notes

- Added `scripts/build-standalone-cli.mjs`, an esbuild-based bundle path that
  discovers all installed `typescript/lib/lib.*.d.ts` files and injects them
  into `globalThis.__js2wasmTsLibFiles` through esbuild's banner.
- Added `preloadLibFiles()` as a public API and cache invalidation hook for
  embedders that want to provide lib declaration text explicitly.
- Added `__JS2WASM_CLI_VERSION__` compile-time injection support so standalone
  bundles do not need `package.json` at runtime.
- Marked Binaryen as an optional peer/dev dependency and kept it out of the
  standalone bundle; `-O` can still use an installed `binaryen` package or a
  `wasm-opt` binary on PATH.
