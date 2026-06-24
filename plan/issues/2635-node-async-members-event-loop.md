---
id: 2635
title: "Async node:fs / process.stdin members over the event loop (Phase 3 of #1772)"
status: ready
created: 2026-06-24
updated: 2026-06-24
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: 65
es_edition: n/a
depends_on: [2632]
related: [1772, 2631, 2632, 2634]
origin: "Phase 3 split out of #1772; gated on the WASI async event loop (#2632)"
---
# #2635 — async Node members over the event loop (Phase 3)

Phase 3 of #1772. The fd-based synchronous `node:fs` core (`readSync`/`writeSync`)
is portable across all three host classes today (Phase 0 ABI + Phase 1 proof,
both landed). The **async** Node surface is not, and is gated on the event loop.

## Problem

Node's async surface — `process.stdin` as a `Readable`, `fs.promises.*`,
EventEmitter-driven IO — has no synchronous fd primitive to lower to. The
`node:fs` pointer-ABI (`docs/architecture/node-fs-abi.md`) can stay identical in
shape, but each provider must drive a loop:

- the pure-WASI provider drives `poll_oneoff` over the shim;
- `edge.js` borrows the JS host's event loop.

Both require a real async runtime, which is #2632 (WASI async event-loop reactor).

## Scope (deferred until #2632 lands)

- Extend the `node:fs` interface (and `node:process`) with the async members,
  keeping the per-member ABI contract from Phase 0.
- Pure-WASI provider: drive `poll_oneoff`; `edge.js`: delegate to the JS loop.
- Same-binary dual-provider proof extended to an async member.

## Acceptance

- Blocked on #2632. When unblocked: one async `node:fs`/`process.stdin` member
  runs under both providers from the same compiled binary, with a test.

## Out of scope

- Path-based `node:fs` (`readFileSync(path)`, `open`) — separate capability tier
  needing a filesystem (`--allow-fs`/preopens), not async-gated.
