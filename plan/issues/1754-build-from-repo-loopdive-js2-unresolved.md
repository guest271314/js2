---
id: 1754
title: "Build-from-repo: packages/index re-exports unresolved @loopdive/js2"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: medium
feasibility: medium
task_type: bugfix
area: packaging
goal: platform
sprint: Backlog
related: [389, 1530]
---
# #1754 — Build-from-repo: `@loopdive/js2` re-export unresolved

## Context

External contributor (GitHub #389, 2026-05-24) hit this building from a fresh
clone:

> if I'm building from the repository `packages/index.js` is referring to
> `export * from "@loopdive/js2";` which ain't found.

So a from-source build trips over a `packages/index.js` that re-exports the
published package name `@loopdive/js2`, which isn't resolvable in-repo (the
package isn't installed / not linked to the workspace). This is a
developer-experience / packaging break for anyone compiling the examples from a
checkout rather than an installed npm package.

## Scope

- Reproduce a clean-clone build of the examples (the path the contributor took:
  `git clone` → build `examples/native-messaging/host.ts`).
- Fix the `packages/index.js` → `@loopdive/js2` resolution so a from-source
  build resolves the workspace package (workspace alias / relative re-export /
  `pnpm` workspace link), OR document the supported build command if building
  from source is meant to go through a different entry.
- Make `examples/native-messaging/smoke-test.sh` representative of the
  from-clone path so this regresses loudly if it breaks again.

## Acceptance

- A fresh clone can compile `examples/native-messaging/host.ts --target wasi`
  without an unresolved `@loopdive/js2` error, using a documented command.
- Smoke-test / CI exercises that path.
