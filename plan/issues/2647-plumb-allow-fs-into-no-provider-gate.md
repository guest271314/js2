---
id: 2647
title: "Plumb --allow-fs into the node:fs no-provider capability gate (P2-a.0) — unhardcode allowFs:false"
status: backlog
created: 2026-06-24
updated: 2026-06-24
priority: low
feasibility: low
reasoning_effort: low
task_type: feature
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
related: [1772, 2634]
origin: "Slice P2-a.0 of the #1772 Phase 2 capstone (arch-capstone scoping, 2026-06-24). PR #2014 landed the no-provider gate with allowFs hardcoded false to keep the slice atomic; this threads the real flag."
---
# #2647 — plumb `--allow-fs` into the no-provider gate (P2-a.0)

## Problem

The #1772 Phase 2 no-provider gate (PR #2014, in
`src/codegen/node-fs-api.ts::tryCompileNodeFsCall`) calls
`isMemberSatisfiable("node:fs", member, { wasi: ctx.wasi, allowFs: false })` with
**`allowFs` hardcoded `false`**. So a path-based `node:fs` member
(`readFileSync(path)`, `openSync`, …) always errors under `--target wasi`, even
when a JS-host filesystem provider (or a WASI filesystem with preopens) IS
available. The capability map already models `allowFs` in `providersFor`; only
the flag plumbing is missing.

## Scope (small, isolated)

- Thread an `--allow-fs` CLI flag → `compile()` options → `ctx.allowFs`
  (`src/codegen/context/types.ts` `CodegenContext`), defaulting to `false`.
- Replace the hardcoded `false` in the gate with `ctx.allowFs`.
- When `--allow-fs` is set under a JS host, path-based `node:fs` members resolve
  through the real `node:fs` (or the host filesystem provider) instead of erroring.
- Document the standalone-WASI story: `--allow-fs` under `--target wasi` requires
  a WASI filesystem (`path_open`/preopens); without it the precise error stands.

## Acceptance

- `--allow-fs` makes a `readFileSync(path)` program compile (no "no provider"
  error) under the JS-host filesystem provider; without it the precise #1772
  error still fires.
- fd-based `readSync`/`writeSync` unchanged (always satisfiable).
- Test toggling the flag; validate IN BATCH + `runTest262File` (per #1968),
  byte-neutral when the flag is unset.

## Out of scope

- A full WASI filesystem backend (preopens) — that is a separate, larger tier.
- The capability gate itself (#1772 P2-a, landed).
