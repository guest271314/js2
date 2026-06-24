---
id: 2635
title: "Async node:fs / process.stdin members over the event loop (Phase 3 of #1772)"
status: done
assignee: sdev-2635
completed: 2026-06-24
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

## Implementation notes (P3-a + P3-b + P3-c — 2026-06-24, sdev-2635)

Landed slices P3-a + P3-b + P3-c in one PR. **P3-d (asyncify incremental
loop-borrow) is the remaining deferred fidelity follow-up** — not done here.

### What was actually the gap (regrounded against current main)
#2632 already shipped the ENTIRE WASI side of async `process.stdin`: the
fd0-readiness reactor (`async-scheduler.ts`: `buildRunLoopBodyWithFdReactor`,
`__rl_stdin_drain`, multi-subscription `poll_oneoff`), the four `__wasiStdin*`
reactor intrinsics, and a faithful byte-chunk `Readable` substrate
(`tests/issue-2632-phase3-stdin-readable.test.ts` proves the WASI arm under both
the JS polyfill and real wasmtime). So the true #2635 gap was exactly ONE thing:
the **edge.js (native-Node) arm** of the same-binary async proof.

### The load-bearing architectural fact (why the seam is `wasi_snapshot_preview1`, not `node:fs`)
The async `process.stdin` reactor is **WASI-internal**: `__run_event_loop` is
wired into `_start` and drives `poll_oneoff`/`fd_read`/`fd_fdstat_set_flags`/
`clock_time_get`/`fd_write` **directly as `wasi_snapshot_preview1` imports**.
There is no exported per-tick API and no `node:fs`-member ABI for the async path
(unlike the synchronous `readSync`/`writeSync`, which ARE `node:fs` closures
edge.js can satisfy — Phase 1). So the provider seam for the async path is the
`wasi_snapshot_preview1` import surface. edge.js's `createNodeStdinWasiProvider`
provides exactly that surface, fed by Node's real `process.stdin` events.

### The sync/async impedance + the decision I owned
The wasm reactor's `_start` is a **synchronous** `poll_oneoff`-blocking loop;
Node's stdin is **async**. Calling `_start()` and letting `poll_oneoff` block
deadlocks (data only arrives when the JS loop is free). I used **MECHANISM 2
(pre-drain)**: `await` Node's real `process.stdin` to `'end'`, collecting all
chunks (this genuinely borrows Node's event loop for the collection phase), THEN
run `_start()` so every `poll_oneoff` finds data/EOF immediately and never truly
blocks. This is the proven `setStdin(bytes)` + `_start()` path #2632 validated
byte-identically against wasmtime. **Mechanism 1** (true incremental
asyncify-suspend loop-borrow) is the deferred **P3-d**; the `P3-d SEAM` comment
in `edge.js` marks where it would slot in.

### Crucial codegen constraint discovered (memory ownership)
The async proof program must be **pure `--target wasi`** (owns + EXPORTS its own
`memory`), NOT `--link-node-shims`. A first attempt mixed `node:fs` writeSync
(imported memory, Phase-1 model) with the native WASI reactor; under wasmtime it
failed with **"missing required memory export"** — wasmtime's native
`wasi_snapshot_preview1.fd_read`/`clock_time_get` require the COMMAND module to
export `memory`, but a `node:fs`-importing module imports memory from the shim
and exports none. The pure-wasi program (memory self-owned + exported) is what
both wasmtime and edge.js bind. edge.js binds it lazily from
`instance.exports.memory` after instantiation.

### Provider semantics (mirror `buildWasiPolyfill` exactly, byte-for-byte)
- `fd_read(0)`: drain the pre-collected queue into the iovec base, return count;
  0-byte read == EOF (queue empty) — `__rl_stdin_drain`'s contract.
- `poll_oneoff`: fd0 FD_READ fires when bytes remain (else CLOCK; else fd0 anyway
  so the reactor's EOF read ends the subscription rather than hanging).
- `fd_fdstat_set_flags`: no-op ack (fd_read already non-blocking vs the queue).
- `fd_write`: writes RAW bytes to the real fd1/fd2 (NOT line-buffered through
  console.log) — required for byte-identity with wasmtime's native fd_write.
- Re-reads `memory.buffer` per `fd_read`/`fd_write` so a `memory.grow` between
  calls can't leave a detached view (matches Phase-1 `createNodeFsProvider`).

### Dependency choice
Kept the example **zero-dependency** (only `node:` imports), inlining the minimal
`wasi_snapshot_preview1` subset rather than importing `buildWasiPolyfill` from the
built `dist/` runtime (Phase-1 "thin adapter" precedent). This makes the edge.js
arm a genuinely INDEPENDENT provider that must AGREE byte-for-byte with both
wasmtime AND the in-tree polyfill — a stronger proof than re-exporting the
polyfill verbatim. Recorded in an `edge.js` comment; if semantics ever drift,
prefer reusing `buildWasiPolyfill` via a small `edge-wasi.mjs` helper.

### Files
- `examples/native-messaging/edge.js` — added `createNodeStdinWasiProvider`
  (the async provider) + `drainProcessStdin` helper (P3-a).
- `examples/native-messaging/run-edge-stdin.mjs` — native-Node async runner (P3-b).
- `tests/issue-2635-async-dual-provider.test.ts` — same-binary byte-identical
  proof: one compiled `process.stdin` line-count + byte-echo binary, byte-identical
  output under wasmtime AND edge.js, across frames incl. `0x00/0xff/0x80/0x0a` (P3-c).

### Validation
No compiler-core change (example + test + runtime-mirroring helper only). New test
green under both arms; `tests/issue-1772-*` + `tests/issue-2632-phase3-*` green
(no regression); tsc + biome lint/format clean. This closes Phase 3 of #1772;
#1772 itself stays in-progress for P2-c.
