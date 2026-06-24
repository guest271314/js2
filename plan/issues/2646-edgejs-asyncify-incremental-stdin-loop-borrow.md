---
id: 2646
title: "edge.js async stdin: true incremental loop-borrow via asyncify (P3-d) — suspend poll_oneoff instead of pre-draining to EOF"
status: backlog
created: 2026-06-24
updated: 2026-06-24
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
depends_on: [2635]
related: [2635, 2632, 1772]
origin: "Slice P3-d of the #2635 async dual-provider proof (arch-capstone scoping, 2026-06-24). A `P3-d SEAM` marker comment was left in examples/native-messaging/edge.js where this slots in. Deferred as a fidelity follow-up — the basic proof (#2635, PR #2012) used mechanism 2."
---
# #2646 — edge.js incremental loop-borrow via asyncify (P3-d)

## Problem

The #2635 dual-provider proof (PR #2012) showed the SAME `process.stdin` wasm
binary runs byte-identically under wasmtime (native WASI `poll_oneoff`) AND
edge.js (native Node). But it used **mechanism 2 (pre-drain)**: edge.js `await`s
Node's `process.stdin` to `'end'`, collecting ALL bytes, THEN calls `_start()` so
every `poll_oneoff` finds data/EOF immediately and never truly blocks.

This is correct for batch input but is NOT a *true* incremental loop-borrow: an
interactive/streaming program (one that should react to each line as it arrives,
or never sees EOF) cannot be driven by pre-draining. The wasm reactor's `_start`
is a synchronous `poll_oneoff`-blocking loop, while Node's stdin is async — so to
borrow Node's loop incrementally, the wasm stack must be able to *suspend* at
`poll_oneoff` and resume on the next `'data'` tick.

## Scope

- Apply **asyncify** (`wasm-opt --asyncify`) to the reactor's blocking points so
  `poll_oneoff` suspends the wasm stack, returns control to Node, and resumes on
  the next `process.stdin` `'data'`/`'end'` event.
- Extend `createNodeStdinWasiProvider` in `examples/native-messaging/edge.js`
  (the `P3-d SEAM` marker) to drive the asyncify unwind/rewind around the async
  stdin queue, replacing the pre-drain.
- Prove an *interactive/streaming* program (reacts per-chunk, no up-front EOF)
  runs under edge.js with the same observable behavior as wasmtime.

## Acceptance

- An interactive `process.stdin` program (e.g. echo-per-line that flushes before
  EOF) runs under edge.js via incremental asyncify loop-borrow, observably
  matching the wasmtime arm, WITHOUT pre-draining to EOF first.
- The existing mechanism-2 batch proof (#2635) still passes (no regression).
- Document the binary-size / perf cost of asyncify and gate it behind an opt-in
  so non-interactive builds keep the cheaper pre-drain path.

## Out of scope

- The batch dual-provider proof (#2635, landed).
- The WASI/wasmtime arm (already incremental via native `poll_oneoff`).
