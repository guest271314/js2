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

## Implementation Plan

> Author: architect (2026-06-25). Scoping pass — **do not start coding before
> reading the size verdict below.** The honest finding is that a _native_
> `wasi:io/poll` core-import lowering is a multi-issue component-model epic that
> contradicts the project's "core-wasm linking over Component Model" decision
> (`project_wasm_linking_core_over_component`), while a _behaviourally complete_
> Preview-2 interop story is already reachable with **zero new codegen** via the
> standard Preview-1→Preview-2 adapter. The plan therefore splits into a small
> high-value first slice (adapter) and a large, deferrable native slice.

### Root cause / why this is "hard"

The reactor today (`src/codegen/async-scheduler.ts`) emits a **core wasm module**
whose readiness primitive is a direct function import
`wasi_snapshot_preview1.poll_oneoff(in,out,nsubs,nevents) -> errno` (see
`buildPollFd0OrClockBody`, line ~2441) plus `fd_read` / `fd_fdstat_set_flags`
(`buildStdinDrainBody`, line ~2272). These are plain i32/i64 core imports —
nsubs/nevents are pointers into linear memory; the `subscription_t` /`event_t`
structs are hand-laid-out byte blobs.

Preview-2 `wasi:io/poll` is **not** a core-function ABI. `pollable` is a
**resource** (an opaque owned handle with `own<pollable>` / `borrow<pollable>`
drop semantics) and `poll.poll(list<pollable>) -> list<u32>` is lowered through
the **Canonical ABI** (`list<>` realloc, post-return cleanup, resource tables).
The same is true of `wasi:io/streams.input-stream` (a resource with
`read`/`blocking-read`/`subscribe` methods returning `result<list<u8>, stream-error>`)
and `wasi:clocks/monotonic-clock.subscribe-duration`. A core wasm module **cannot
import these directly** — they only exist at the component boundary. Bridging
requires either:

1. a **component wrapper** (a WIT world + `wasm-tools component new` / `jco` to
   adapt the core module to a component that the host satisfies with real
   Preview-2 interfaces), **or**
2. emitting the canonical-ABI lowering ourselves (resource tables, `list`
   realloc, the `cabi_realloc` export, a `component-type` custom section) — i.e.
   making js2wasm a component producer. That is a large, cross-cutting effort and
   is **explicitly deferred** by `project_wasm_linking_core_over_component` (the
   Component Model is deferred to #2525; core-wasm linking #2527 is the chosen
   mechanism).

**Key environment fact that resizes this issue:** the repo already ships the
official adapter — `@bytecodealliance/jco@1.17.6` provides
`lib/wasi_snapshot_preview1.command.wasm` (and `.reactor.wasm`), and `wasmtime
44` runs Preview-2 components natively. The adapter wraps our **existing,
unchanged Preview-1 core module** into a Preview-2 component whose `poll_oneoff`
is satisfied by the host's real `wasi:io/poll`+`wasi:clocks`+`wasi:io/streams`.
So "the reactor runs correctly under a Preview-2 host" needs **no reactor change
at all** — only a build/test step. The only thing the native path buys is
_emitting `wasi:io/poll` imports directly_ (no adapter shim), which is an
ABI-purity goal, not a behaviour goal.

### Selection mechanism (where a flag threads)

The reactor is gated by `state.stdinReactor` (set via `enableStdinReactor`,
`async-scheduler.ts` ~2707) and the import set is chosen in
`src/codegen/index.ts` by the `needs*` booleans (`needsPollOneoff` ~6147,
`needsStdinReactor` ~6122, `needsFdRead` ~6107). The target enum lives in
`src/index.ts` (`CompileOptions.target: "gc" | "linear" | "wasi" | "standalone"`,
line ~187) and the CLI parse in `src/cli.ts` (~134–164). Two viable selectors:

- **Preferred — a sub-mode flag, not a new target:** add
  `CompileOptions.wasiPreview?: 1 | 2` (default `1`) threaded onto
  `CodegenContext` (e.g. `ctx.wasiPreview`). `--target wasi` stays Preview-1;
  `--wasi-preview 2` (or `--target wasi` + `--wasi-preview 2`) opts in. This
  avoids forking the whole `target` switch (string-target checks like
  `target === "wasi"` appear ~40× in `index.ts`); a sub-flag keeps all of those
  unchanged and only branches the 3 reactor sites.
- _Rejected:_ a brand-new `target: "wasi-p2"` — it would require touching every
  `target === "wasi"` site to also accept the new value, a wide, error-prone
  diff for no behavioural gain.

`AsyncSchedulerState` would carry the choice (add `wasiPreview: 1 | 2`, set in
`getOrInitState` from `ctx.wasiPreview`), and the three reactor builders branch
on it.

### Readiness-primitive mapping (Preview-1 ↔ Preview-2)

| Preview-1 (core import, today)                                                                                | Preview-2 (`wasi:io/poll`, native slice)                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `poll_oneoff(subs_ptr, evts_ptr, nsubs, nevt_ptr)` over a `subscription_t[]` blob (`buildPollFd0OrClockBody`) | `wasi:io/poll.poll(list<borrow<pollable>>) -> list<u32>` over `[stdin-pollable, clock-pollable]`                                              |
| `subscription_t` FD_READ on fd0 (`RL_POLL_SUB0_OFFSET`)                                                       | `[method]input-stream.subscribe(this) -> own<pollable>`, obtained once from the stdin `input-stream` resource                                 |
| `subscription_t` CLOCK_MONOTONIC w/ relative `timeout` (`RL_POLL_SUB1_OFFSET`)                                | `wasi:clocks/monotonic-clock.subscribe-duration(ns) -> own<pollable>`, re-created each tick for `max(0, deadline-now)`                        |
| event scan: `event_t.type == FD_READ` ⇒ readable (`RL_POLL_EVT_OFFSET+10`)                                    | scan the returned `list<u32>` of ready indices for the stdin pollable's index                                                                 |
| `fd_fdstat_set_flags(0, NONBLOCK)` + `fd_read(0, iov, 1, nread)` (`buildStdinDrainBody`)                      | `[method]input-stream.read(this, len) -> result<list<u8>, stream-error>` (non-blocking; `closed` ⇒ EOF), copy bytes into `RL_STDIN_BUF_START` |
| EOF = 0-byte read at readable fd ⇒ `stdinFdActive=0`                                                          | EOF = `read` returns `stream-error::closed` ⇒ `stdinFdActive=0`                                                                               |
| `clock_time_get(MONOTONIC,…)` for now (`__rl_now_ns`)                                                         | `wasi:clocks/monotonic-clock.now() -> instant (u64 ns)`                                                                                       |

The substrate seam holds in **both** directions: only `buildStdinDrainBody`,
`buildPollFd0OrClockBody`, and `__rl_now_ns`'s body change; the run-loop driver
(`buildRunLoopBodyWithFdReactor`), the timer heap, the Phase-3 reader-tick hook,
the four `__wasiStdin*` intrinsics, and the whole `process.stdin` Readable
library are **untouched**. That is the property the issue's "Notes" already
assert, and it is correct.

### Changes

#### Slice A — Preview-2 _interop_ via the adapter (NO codegen change)

**Goal:** prove (and ship a test for) the existing Preview-1 core module running
correctly under a real Preview-2 host, satisfying the issue's end-to-end
acceptance bullet without any reactor rewrite.

- **New build helper** `scripts/wasi-p2-component.mjs` (or a test-local helper):
  given a compiled `--target wasi` core `.wasm`, run
  `jco new <core.wasm> --wasi-reactor` (equivalently
  `wasm-tools component new --adapt wasi_snapshot_preview1=<jco>/lib/wasi_snapshot_preview1.reactor.wasm`)
  to produce a Preview-2 **component**. Resolve the adapter path from the
  installed `@bytecodealliance/jco` package (`lib/wasi_snapshot_preview1.reactor.wasm`).
  - Note: `_start`-driven programs (our reactor runs in `_start`) use the
    **command** adapter (`.command.wasm`); a library/reactor-export shape uses
    `.reactor.wasm`. Pick per the module's exports (we export `_start` →
    command).
- **New test** `tests/issue-2643-wasi-p2-adapter.test.ts`: compile the **same**
  programs as `tests/issue-2632-phase3-stdin-prelude.test.ts`, adapt to a
  component, run under `wasmtime run --wasm component-model=y` (wasmtime 44 is
  present; gate on `findWasmtime()` exactly like the Phase-2 test does), pipe
  stdin, and assert byte-identical streaming output to the Preview-1 run. This
  directly satisfies the issue's "end-to-end test … running under a Preview-2
  host" bullet.

This slice is the **honest "deliver Preview-2 value now"** answer: it is how the
ecosystem actually targets WASI 0.2 from a Preview-1 producer, and it costs
roughly one script + one test, no `async-scheduler.ts` change.

#### Slice B — native `wasi:io/poll` reactor lowering (large; deferable)

Only pursue if there is a concrete requirement to emit `wasi:io/poll` imports
**without** the adapter (e.g. a host that refuses the Preview-1 adapter, or an
ABI-purity mandate). This makes js2wasm a (partial) **component producer** and
overlaps the deferred #2525 Component-Model track.

- **`src/index.ts`** — add `wasiPreview?: 1 | 2` to `CompileOptions` (~187);
  default 1.
- **`src/cli.ts`** — parse `--wasi-preview <1|2>` (~134–164); reject `2` unless
  `target === "wasi"`.
- **`src/codegen/context/types.ts`** — add `wasiPreview: 1 | 2` to
  `CodegenContext`; populate from options where the context is built.
- **`src/codegen/async-scheduler.ts`** —
  - `AsyncSchedulerState`: add `wasiPreview: 1 | 2`; set in `getOrInitState`.
  - `buildPollFd0OrClockBody` (~2441): when `wasiPreview === 2`, emit the
    `wasi:io/poll.poll` call over a `list<borrow<pollable>>` built from the
    cached stdin pollable + a freshly `subscribe-duration`'d clock pollable;
    scan the returned ready-index `list<u32>`.
  - `buildStdinDrainBody` (~2272): when `wasiPreview === 2`, replace
    `fd_fdstat_set_flags`/`fd_read` with `input-stream.read` and map
    `stream-error::closed` → EOF.
  - `__rl_now_ns` body: when `wasiPreview === 2`, call `monotonic-clock.now`.
  - New per-module globals to **cache the stdin `input-stream` + its `pollable`
    handles** (resource handle ints) so they are acquired once, not per tick.
- **`src/codegen/index.ts`** — when `needsStdinReactor && wasiPreview === 2`,
  register the Preview-2 imports **instead of** `poll_oneoff`/`fd_read`/
  `fd_fdstat_set_flags`: the `wasi:io/poll`, `wasi:io/streams`,
  `wasi:clocks/monotonic-clock` interface functions, plus the
  `[resource-drop]pollable` / `[resource-drop]input-stream` intrinsics. This is
  where the **hard part** lives — these are component-model lowerings, so the
  module must also gain a `cabi_realloc` export and a `component-type` custom
  section (WIT world) for the adapter/host to bind. This is the piece that pulls
  in component-producer machinery and is **out of scope for a single PR**.
- **WIT world** — author `wit/js2wasm-reactor.wit` importing the three
  interfaces; wire `src/wit-generator.ts` (or `wasm-tools component embed`) to
  attach it.

### Edge cases (apply to whichever slice ships the behaviour)

- **EOF mapping** — Preview-1: 0-byte read at a readable fd. Preview-2:
  `input-stream.read` returns `stream-error::closed`. Both must set
  `stdinFdActive = 0` exactly once and not spin (the current `EBADF`/error arm in
  `buildStdinDrainBody` ~2378 is the model).
- **Pollable lifetime / resource leaks** — the clock pollable is created **per
  tick** (new duration each loop) and MUST be `[resource-drop]`-ed before the
  next `poll`, or the resource table leaks. The stdin pollable + input-stream are
  created **once** and dropped only at loop exit. Getting this wrong is a
  host-side trap, not a wasm validation error — easy to miss.
- **`list<borrow<pollable>>` vs `own`** — `poll.poll` takes _borrows_; the owned
  handles stay owned by us. Don't double-drop.
- **No-import / polyfill fallback** — both `buildStdinDrainBody` and
  `buildPollFd0OrClockBody` already have a "no import registered" arm (~2283,
  ~2452). The Preview-2 path needs the equivalent guard so a misconfigured build
  degrades to "report EOF / not-readable and exit" rather than emitting a call to
  an unregistered func index.
- **Adapter shape (`command` vs `reactor`)** — Slice A must pick the right
  adapter for the module's export shape (`_start` ⇒ command). Wrong adapter =
  instantiation error.
- **Byte-neutrality** — Preview-1 default builds (`wasiPreview` unset/1) must be
  **byte-identical** to today. Slice B's branch must be fully behind the
  `wasiPreview === 2` guard, mirroring how `stdinReactor === false` keeps the run
  loop byte-identical to Phase 1.

### Test shape

- **Slice A:** `tests/issue-2643-wasi-p2-adapter.test.ts` — reuse the
  Phase-3 prelude programs; compile `--target wasi`; adapt with the jco reactor
  adapter; run under `wasmtime --wasm component-model=y` with piped stdin; assert
  output equals the Preview-1 run. Gate on `findWasmtime()` + adapter presence
  (skip cleanly when absent, like the Phase-2 test).
- **Slice B (if pursued):** compile-wiring test (asserts `wasi:io/poll` imports
  present + `poll_oneoff` absent under `--wasi-preview 2`, and byte-neutral
  default), then an end-to-end component run (no adapter) under wasmtime.

### Decomposition into dev-sized slices

| Slice  | What                                                                                                                                                                                                                                                        | Role             | Size               | Depends on         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------ | ------------------ |
| **A**  | Preview-2 **interop** via the jco Preview-1→P2 adapter + end-to-end test. No codegen change.                                                                                                                                                                | developer        | **~1 PR, S/M**     | —                  |
| **B1** | Flag plumbing only: `wasiPreview` on `CompileOptions`/CLI/`CodegenContext`/`AsyncSchedulerState`, default-1 byte-neutral, wiring test. No reactor behaviour yet.                                                                                            | developer        | **~1 PR, S**       | A (optional)       |
| **B2** | Native `wasi:io/poll` + `wasi:clocks` reactor **poll/now** lowering (pollable acquire/drop, `poll.poll`, `now`) behind `wasiPreview===2`. Requires the component-producer scaffolding (cabi_realloc, component-type section, WIT world) — this is the epic. | senior-developer | **multi-PR, L/XL** | B1, overlaps #2525 |
| **B3** | Native `wasi:io/streams` stdin drain (`input-stream.read`, `closed`⇒EOF) + resource-lifetime correctness; end-to-end no-adapter component test.                                                                                                             | senior-developer | **~1–2 PRs, M/L**  | B2                 |
| **B4** | `process.std*.write` backpressure / `'drain'` (#1774) under Preview-2 `output-stream`.                                                                                                                                                                      | senior-developer | **~1–2 PRs, M**    | B3                 |

### Honest size verdict

- **Slice A is the right thing to ship now** — it satisfies the issue's
  user-visible acceptance criterion ("the `process.stdin` Readable runs under a
  Preview-2 host with identical behaviour") with ~1 PR and **no risk to the
  Preview-1 path**, using the ecosystem-standard adapter that is already
  installed. Recommend dispatching A as a `developer` task.
- **Slices B2–B4 are a component-model epic**, not a backend variant. They make
  js2wasm a component producer (canonical ABI, resource tables, `cabi_realloc`,
  a `component-type` custom section) — directly inside the territory the project
  **deferred** in `project_wasm_linking_core_over_component` (#2525 deferred;
  #2527 core-linking chosen). They deliver **no new behaviour** over Slice A
  (the adapter already gives real `wasi:io/poll` at runtime); their only payoff
  is ABI purity (no adapter shim in the toolchain). **Recommendation: keep B2–B4
  in the backlog**, gated on the #2525 Component-Model track actually being
  picked up, and pursue them only if a concrete host requirement forbids the
  adapter. B1 (flag plumbing) is cheap and can land opportunistically as the seam
  for a future B2, but has no standalone value, so it is not worth scheduling on
  its own.
