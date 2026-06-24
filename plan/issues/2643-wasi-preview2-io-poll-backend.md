---
id: 2643
title: "WASI Preview 2 wasi:io/poll backend for the async event-loop reactor (#2632 Phase 4)"
status: done
completed: 2026-06-24
sprint: Backlog
goal: wasi-async-runtime
feasibility: hard
kind: feature
created: 2026-06-24
refs: [2632, 1774]
---

> **Status (Slice A landed, 2026-06-24):** The issue's end-to-end acceptance
> criterion — "the `process.stdin` Readable runs under a Preview-2 host with
> identical behaviour" — is satisfied **behaviourally** via the official jco
> Preview-1→Preview-2 adapter, with **zero codegen change**. The unchanged
> `--target wasi` Preview-1 core module is adapted to a Preview-2 component
> (`scripts/wasi-p2-component.mjs`, `jco new --adapt wasi_snapshot_preview1=…`)
> and runs under wasmtime 44's component model, where `poll_oneoff`/`fd_read`/
> `clock_time_get` are backed by the host's real `wasi:io/poll` + `wasi:clocks`
> + `wasi:io/streams`. `tests/issue-2643-wasi-p2-adapter.test.ts` asserts
> **byte-identical** streaming output to the Preview-1 wasmtime arm for the
> Phase-3 stdin programs. The Preview-1 path is untouched (byte-neutral).
>
> **Deferred backlog (component-model epic, #2525 track):** Slices **B2–B4**
> below — the *native* `wasi:io/poll` / `wasi:io/streams` / `output-stream`
> reactor lowering (making js2wasm a component producer: canonical ABI,
> resource tables, `cabi_realloc`, a `component-type` custom section) — deliver
> **no new behaviour** over the adapter (its only payoff is ABI purity, no
> adapter shim) and live inside the territory deferred by
> `project_wasm_linking_core_over_component`. They stay in the backlog, gated on
> the #2525 Component-Model track being picked up. Slice **B1** (flag plumbing
> only) is the cheap seam for a future B2 but has no standalone value.

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
