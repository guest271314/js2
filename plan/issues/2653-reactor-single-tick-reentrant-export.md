---
id: 2653
title: "reactor single-tick re-entrant export — non-asyncify interactive streaming stdin (drive the #2632 loop per process.stdin 'data')"
status: backlog
created: 2026-06-25
updated: 2026-06-25
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
related: [2646, 2632, 2635]
origin: "Spun off from #2646's investigation (2026-06-24): wasm-opt --asyncify cannot transform our WasmGC reactor binary (Binaryen fake-call-global GC-ref name collision, all of binaryen 123/125/130, both backends). This is the non-asyncify path to the same goal — true incremental loop-borrow — that does NOT depend on the Binaryen bug."
---

# #2653 — reactor single-tick re-entrant export (non-asyncify interactive streaming stdin)

## Problem

The #2632 async event-loop reactor lowers a `--target wasi` `process.stdin`
program's `_start` into a **synchronous** run loop
(`buildRunLoopBodyWithFdReactor` in `src/codegen/async-scheduler.ts`) that blocks
at a single suspend point — `__rl_poll_fd0_or_clock` → the imported
`poll_oneoff` — and runs to completion in one call. Under wasmtime that is fine
(native `poll_oneoff` genuinely blocks on fd0). Under native Node (`edge.js`,
`createNodeStdinWasiProvider`) it cannot block, because the bytes only arrive on
future JS event-loop ticks. The shipped batch mechanism is **pre-drain** (#2635,
landed): collect ALL stdin to EOF first, then call `_start()` so every
`poll_oneoff` finds data/EOF immediately. That is correct for batch but is NOT a
_true_ incremental loop-borrow — an interactive/streaming program (reacts
per-line, flushes before EOF, or never sees EOF) cannot be driven by pre-draining.

The asyncify approach (#2646) — instrument the wasm so `_start` suspends at
`poll_oneoff` and resumes on the next `'data'` tick — is **blocked**: `wasm-opt
--asyncify` aborts on our WasmGC reactor binary with a Binaryen fake-call-global
GC-ref name collision (`asyncify_fake_call_global_(ref null $struct.0) already
exists`), reproduced on binaryen 123/125/130 and on both the CLI and in-process
backends, with no scoping pass-arg able to avoid it. See #2646's
`## Investigation (2026-06-24)` for the full root cause.

## Scope

Provide a **non-asyncify** path to interactive streaming stdin by making the
reactor run loop **re-entrant**: instead of one blocking `_start` that loops on
`poll_oneoff` to completion, expose a **single-tick** entry point that the host
drives once per `process.stdin` `'data'`/`'end'` event.

- Refactor `buildRunLoopBodyWithFdReactor` (`src/codegen/async-scheduler.ts`) so
  the loop body can be invoked as **one tick**: drain whatever bytes are
  currently available, run the registered reader/pump + due timers + microtasks,
  and **return a status** ("more work pending" vs "done") instead of blocking on
  `poll_oneoff` when fd0 would block. The tick must NOT call the blocking
  `poll_oneoff` itself — readiness is decided by the host, which only invokes the
  tick when fd0 is readable or a timer is due.
- Expose this as an export (e.g. `__reactor_tick() -> i32`, returning whether the
  reactor still has live subscriptions/timers) alongside the existing `_start`,
  preserving the reactor's internal state (buffers, timer table, microtask queue,
  fd0-active flag) across calls. The WasmGC reactor state already lives in module
  globals, so re-entrancy is a matter of splitting the loop, not adding a stack
  machine.
- Drive it from `edge.js` (`createNodeStdinWasiProvider`, the `P3-d SEAM`): on
  each `process.stdin` `'data'` chunk, enqueue the bytes and call
  `__reactor_tick()`; on `'end'`, mark EOF and tick until the reactor reports
  no pending work. This replaces pre-drain for the interactive path while
  keeping pre-drain available for batch.
- Preserve byte-for-byte agreement with the wasmtime arm: the SAME program, fed
  the SAME bytes incrementally, must produce the SAME output as
  `wasmtime run <user.wasm>` (which uses the blocking `_start`). The reactor's
  per-tick semantics must be a faithful decomposition of the blocking loop.

## Acceptance

- An interactive `process.stdin` program (e.g. echo-per-line that flushes a
  result on each newline, before EOF) runs under `edge.js` via the single-tick
  re-entrant export, reacting per-chunk **without** pre-draining to EOF first,
  and produces output observably matching the wasmtime arm.
- The existing mechanism-2 batch proof (#2635) still passes (no regression);
  pre-drain remains available for batch input.
- `_start` (the blocking, run-to-completion entry) is unchanged for the
  wasmtime/standalone path — the single-tick export is additive.

## Out of scope

- The asyncify approach (#2646) — this is the independent, Binaryen-bug-free
  alternative. If a future Binaryen fixes the GC-ref fake-call-global collision,
  #2646's scoped-asyncify path becomes viable again; the two are alternatives.
- The batch dual-provider proof (#2635, landed) — pre-drain stays the shipped
  correct mechanism for batch input.
- The WASI/wasmtime arm — already incremental via native blocking `poll_oneoff`.

## Notes

- Single suspend point confirmed: `_start` → `__run_event_loop`
  (`buildRunLoopBodyWithFdReactor`) → `__rl_poll_fd0_or_clock` → imported
  `poll_oneoff` (`src/codegen/async-scheduler.ts`). The refactor splits the
  `loop`/`block` tick body so one iteration can run host-driven, replacing the
  internal blocking poll with a host-decided readiness gate.
- All reactor state (stdin buffer, timer table, microtask queue, fd0-active
  flag) is already in module globals, so re-entrancy needs no asyncify-style
  stack save/restore — this is precisely why it sidesteps the Binaryen bug.
- Provider seam: `examples/native-messaging/edge.js` `createNodeStdinWasiProvider`
  and its `run-edge-stdin.mjs` runner; tests in
  `tests/issue-2635-async-dual-provider.test.ts` are the dual-provider harness to
  extend.
