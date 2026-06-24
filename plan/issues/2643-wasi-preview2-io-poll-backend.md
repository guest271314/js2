---
id: 2643
title: "WASI Preview 2 wasi:io/poll backend for the async event-loop reactor (#2632 Phase 4)"
status: backlog
sprint: Backlog
goal: wasi-async-runtime
feasibility: hard
kind: feature
created: 2026-06-24
refs: [2632, 1774]
---

# WASI Preview 2 `wasi:io/poll` backend (#2632 Phase 4)

## Problem

The #2632 async event-loop reactor (timers, microtasks, the fd0-readiness reactor,
and the Phase-3 `process.stdin` Readable) is implemented today against **WASI
Preview 1** `poll_oneoff` (the blocking multi-subscription sleep on fd0 + a timer).
Preview 1's `poll_oneoff` is deprecated in the Component Model world; the forward
target is **Preview 2 / WASI 0.2's `wasi:io/poll`** (`pollable` handles +
`poll.poll(list<pollable>)`), with `wasi:io/streams` for the stdin
`input-stream`'s readable pollable.

This is **Phase 4** of #2632 — explicitly scoped as a separate, deferred
follow-up in that issue and NOT a blocker for Phase 3 (which shipped on Preview 1).

## Scope

- [ ] A Preview-2 lowering of the run-loop reactor: obtain the stdin
      `input-stream`'s readable `pollable` (`wasi:io/streams.[method]input-stream.subscribe`)
      and the monotonic-clock `pollable` for the next-timer deadline
      (`wasi:clocks/monotonic-clock.subscribe-duration`), and block in
      `wasi:io/poll.poll` instead of `poll_oneoff`.
- [ ] Non-blocking drain of the stdin `input-stream` (`read`/`blocking-read`) into
      the same internal buffer the Phase-2/3 substrate already uses, so the
      Phase-3 `process.stdin` Readable library is **backend-agnostic** (no library
      change — only the reactor's poll/drain primitives swap).
- [ ] Backend selection: keep Preview 1 as the default `--target wasi` lowering;
      add an opt-in (e.g. `--target wasi-p2` or a `--wasi-preview 2` flag) that
      emits the `wasi:io/poll` imports. Both backends stay (dual-mode, per the
      architecture principles).
- [ ] An end-to-end test of the `process.stdin` Readable (the same programs as
      `tests/issue-2632-phase3-stdin-prelude.test.ts`) running under a Preview-2
      host (wasmtime component / jco), asserting identical streaming behaviour.

## Notes

- Track the real async stream semantics (backpressure, `'drain'`) here too — see
  #1774 (the `process.std*.write` backpressure note deferred from Preview 1).
- The Phase-3 reactor-tick hook + the four stdin intrinsics
  (`__wasiStdinReadByte`/`Available`/`Eof`/`SetReader`) are the substrate seam: a
  Preview-2 backend reimplements only `__rl_stdin_drain` + the blocking-poll body
  in `buildRunLoopBodyWithFdReactor` (`src/codegen/async-scheduler.ts`); the
  library and intrinsic surface are unchanged.
