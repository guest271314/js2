---
id: 1772
title: "Spike edge.js as a Node API module / WASI shim layer"
status: backlog
created: 2026-06-01
updated: 2026-06-01
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: research
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
related: [389, 1575, 1766]
origin: "Follow-up from PR #1010 review direction"
---
# #1772 — Spike edge.js as a Node API module / WASI shim layer

## Problem

PR #1010 exposes a narrow `node:process` stream compatibility path for WASI, but
Node-shaped host APIs should not keep accumulating as ad hoc cases in the
generic compiler. We should evaluate whether edge.js can be used as a separate
Node API module / shim layer that user code imports, with the compiler lowering
only the explicit shim surface to WASI.

## Scope

- Investigate whether edge.js can provide or host a small Node-compatible API
  surface for `process.stdin`, `process.stdout`, `process.stderr`, and future
  stream/EventEmitter pieces.
- Prototype the import shape we want users to write, such as `node:process` or
  an explicit js2wasm Node API module, and document how it composes with
  `--target wasi`.
- Identify which pieces can compile away to WASI syscalls and which pieces need
  a JS host shim, async scheduler, or EventEmitter work.

## Acceptance

- A spike branch documents whether edge.js is viable for the Node/WASI shim
  layer and why.
- The spike includes one minimal imported-process example that compiles under
  `--target wasi` or records the blocker precisely.
- Follow-up issues are filed for any concrete implementation slices.
