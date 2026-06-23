---
id: 2632
title: WASI async runtime — event-loop reactor (process.stdin Readable, timers, promise-driven I/O)
status: ready
sprint: Backlog
goal: wasi-async-runtime
feasibility: hard
kind: goal
created: 2026-06-23
refs: [389, 2631, 1326, 1326c, 1484, 1653, 2524]
---

# WASI async runtime — event-loop reactor

> **This is a GOAL (a major multi-phase feature), not a patch.** It introduces a
> real single-threaded cooperative event loop into the WASI target so js2wasm can
> compile **general async / streaming Node programs** to standalone Wasm. The
> motivating deliverable is a faithful `process.stdin` Readable stream. Phases are
> independently shippable. Scope each phase as its own implementation issue when it
> is pulled into a sprint.

## Problem

External reporter **guest271314** (loopdive/js2 #389) correctly observed that
js2wasm's current synchronous `process.stdin.read(buffer, offset)` (#1653) matches
**no real Node API**. In Node, `process.stdin` is an async **Readable** stream:

- `.read([size])` takes **no buffer** — it allocates and **returns** a `Buffer`/string,
  or **`null`** when insufficient data is buffered.
- It is canonically driven by `'readable'` / `'data'` **events** on an **event loop**.
- Reading is non-blocking: data arrives over time and the program reacts.

js2wasm has no event loop, so today:

- `setTimeout` / `setInterval` / `setImmediate` are **rejected at compile time**
  under `--target wasi` (`rejectTimersUnderWasi`, `src/codegen/index.ts:12665`).
- `process.stdin.read(buf, off)` is a **synchronous, buffer-in** shim (#1653,
  `src/codegen/node-process-api.ts`) — a bespoke API that no Node program uses.
- Promises run only as a **one-shot microtask drain** after the entry function
  returns (#1326c) — there is no loop to interleave timers or I/O readiness with
  microtask draining.

The synchronous Native-Messaging host (fd-based `node:fs` `readSync`/`writeSync`)
is handled **separately by #2631** and needs **no** event loop. **This goal is the
bigger prize**: a real event-loop reactor that lets timers, promises, and I/O
readiness drive each other — the libuv role — over WASI.

This is single-threaded **cooperative** concurrency. It matches Node's loop exactly;
we do **not** need (or get) OS-thread preemption. It does **not** block #2631 and is
not required by it.

## What already exists (the substrate — verified against the code)

The hard pieces are largely in place. The reactor is mostly **wiring** them into a
loop, not building from scratch.

1. **Standalone microtask queue + Promise GC struct** — `src/codegen/async-scheduler.ts`
   (#1326 / #1326c, ~1260 lines). `$Promise` struct (`PROMISE_STATE_PENDING/FULFILLED/REJECTED`),
   a funcref+externref+externref triple-array microtask queue with head/tail/cap
   globals, `__microtask_enqueue` / `__drain_microtasks` / `__microtask_grow`
   helpers, and standalone `Promise.resolve`/`.reject`/`.then`. The drain is
   **already exported** and **already auto-called from WASI `_start`**.

2. **Async/await CPS state machine** — `src/codegen/async-cps.ts` (#1042 / #1373b,
   `ASYNC_CPS_ENABLED = true`). An `async function` that genuinely suspends is
   lowered to a generator-style state machine: `splitBodyAtAwait` cuts the body at
   each `await`, `analyzeAsyncBody` computes the live-local capture set across each
   await, segments compile as continuation callbacks chained via `Promise.then`.
   The per-function `asyncFnNeedsCps` predicate keeps await-elidable bodies on the
   synchronous path. This is the resumable-continuation substrate the reactor needs
   — `await` already turns into "register a continuation, return; the continuation
   fires when the awaited Promise settles."

3. **WASI `poll_oneoff` import + a working subscription/event marshaller** —
   `registerWasiImports` (`src/codegen/index.ts:5963`) already registers
   `poll_oneoff(in, out, nsubs, nevents_out) -> errno`, and `emitWasiSleepMsHelper`
   (`src/codegen/index.ts:7264`) already **marshals a 48-byte `subscription_t`
   into linear scratch** (CLOCK_MONOTONIC, relative timeout in ns) and reads back
   the 32-byte `event_t`. This is exactly the libuv-`poll` ABI the reactor needs —
   today wired only for a single blocking clock subscription. There is a matching
   `poll_oneoff` polyfill in `src/runtime.ts:12119` for vitest-driven tests.

4. **WASI `_start` wrapper** — `addWasiStartExport` (`src/codegen/index.ts:1998`)
   builds `_start` as `call <entry>; call __drain_microtasks`. The drain call is
   appended via `getDrainFuncIdxForWasiStart` (`async-scheduler.ts:1066`). **This is
   the single insertion point** where the one-shot drain becomes a run-loop driver.

5. **Per-module Node shim boundary** — `js2wasm:node-process` (#2524, `--link-node-shims`,
   `src/codegen/node-process-api.ts`, `examples/native-messaging/node-process.wat`).
   Per memory `feedback_node_apis_via_per_module_shim_not_builtin`, Node surfaces
   (process streams, timers) belong in **per-module shims / library code**, with the
   reactor **primitive** (`poll_oneoff`) as the host import. Keep Node semantics out
   of codegen core.

6. **`fd_read` import** is already registered for #1653's synchronous stdin path
   (`src/codegen/index.ts:5943`), with a page-1 stdin buffer (`WASI_STDIN_BUF_START`).
   The reactor reuses `fd_read` but drives it from readiness, not a blocking call.

## Honest framing / risks

- **Scope.** This is a WASI **async runtime**, comparable to what QuickJS-on-WASI or
  Javy build. Treat it as a goal with phases, not a single PR.
- **The async state machine extends cleanly to a top-level reactor** — with one
  caveat (below). The CPS lowering already produces resumable continuations chained
  on Promise settlement; a reactor is "keep draining microtasks, then fire due timers
  / dispatch ready I/O, which settle Promises, which enqueue more microtasks, until
  no pending handles remain." The loop driver lives in `_start`, replacing the
  one-shot drain. **No new suspension mechanism is required** for `await`-driven code.
- **Caveat — top-level `await` is currently a skip filter, not lowered.** The CPS
  machine lowers `await` **inside `async function` bodies**. Top-level `await` (module
  scope) is in the test262 skip set (CLAUDE.md) and is **not** run through
  `splitBodyAtAwait`. Phase 1's loop driver does **not** require top-level await: a
  program's top level *schedules* work (`setTimeout(...)`, `p.then(...)`,
  `stream.on(...)`) synchronously and returns; the loop then runs. Programs that use
  **top-level `await`** to suspend module evaluation itself are out of Phase-1 scope
  and remain a separate concern (would need module-init itself lowered to a state
  machine). **This is the one place the existing model does not already reach** — call
  it out explicitly; do not pretend the reactor gives top-level await for free.
- **Backend.** The `subscription_t`/`event_t` ABI is **linear-memory**. The WASI
  target already runs in a hybrid mode: a linear memory is present (`registerWasiImports`
  pushes `memories`/exports it) alongside WasmGC structs. The poll/I/O marshalling
  reuses the existing page-0 scratch + page-1 stdin buffer convention from #1484/#1653.
  This is **not** the `src/codegen-linear/` backend — it is the WasmGC codegen path
  with its companion linear memory. (`src/codegen-linear/` remains the pure-linear
  WASI/edge alternative; a future phase could host the reactor there too, but Phase 1
  targets the existing `--target wasi` WasmGC+linear path where the substrate lives.)
- **Reentrancy / ordering.** Node's loop has a precise phase order (timers → pending →
  poll → check → close) and drains the **microtask queue between every callback**.
  Faithfulness here is a long-tail; Phase 1 targets the observable subset
  (microtasks-before-timers, timers in deadline order, `queueMicrotask`).
- **Preview 2.** WASI Preview 2 / Component Model (`wasi:io/poll` + `wasi:io/streams`)
  is the cleaner future substrate (it is what ComponentizeJS — which the reporter says
  "works" — runs on). Recommend Preview 1 `poll_oneoff` for the first implementation
  (it is what `--target wasi` emits today and the marshaller already exists); add a
  Preview 2 backend as Phase 4.

## Acceptance criteria (phased)

### Phase 1 — scheduler + timers + microtasks (smallest viable first slice)
- [ ] A **run-loop driver** function (`__run_event_loop`) replaces the one-shot
      `__drain_microtasks` call in the WASI `_start` wrapper. It loops:
      drain microtasks → if any timer is due, fire it → if timers remain pending,
      `poll_oneoff` on the nearest deadline → repeat → exit when no pending handles.
- [ ] `setTimeout(cb, ms)` / `setInterval(cb, ms)` / `clearTimeout`/`clearInterval`
      compile under `--target wasi` (remove them from `WASI_REJECTED_TIMER_GLOBALS`)
      and are driven by the loop via a **timer heap**, not a blocking sleep.
- [ ] `queueMicrotask(cb)` compiles under WASI and enqueues onto the existing
      microtask queue.
- [ ] Ordering: all microtasks drain **before** the first due timer fires; timers fire
      in non-decreasing deadline order; a `setTimeout(…, 0)` fires after sync code and
      after pending microtasks.
- [ ] Existing #1326/#1326c Promise tests still pass; existing `wasi-timers.test.ts`
      (the #1484 diagnostic) is updated from "rejects" to "compiles + runs".
- [ ] New `tests/issue-2632-wasi-event-loop.test.ts` covering timer ordering,
      microtask-before-timer, and nested `setTimeout` scheduling.

### Phase 2 — poll_oneoff reactor + non-blocking fds
- [ ] Set fd 0 non-blocking via `fd_fdstat_set_flags` at loop start.
- [ ] The loop builds a **multi-subscription** `poll_oneoff` set: fd0-readable +
      nearest timer deadline (clock). Dispatch the returned `event_t`s: a readable
      fd0 event triggers a non-blocking `fd_read` into the stdin buffer and feeds the
      stream buffer; a clock event fires the due timer(s).
- [ ] EOF on fd0 (`fd_read` returns 0 bytes with the FD_READ event set / `nbytes==0`)
      ends the readable side.
- [ ] Reactor exits when no pending timers **and** no fd subscriptions remain.

### Phase 3 — process.stdin Readable stream (the deliverable)
- [ ] `process.stdin` is a real Readable / EventEmitter, provided via the
      `js2wasm:node-process` shim + library code (NOT codegen builtins):
      `.on('readable', cb)`, `.on('data', cb)`, `.on('end', cb)`, `.read([size]) →
      Buffer|string|null` with internal buffering, `.pause()`/`.resume()`.
- [ ] `.read(size)` returns `null` when fewer than `size` bytes are buffered, a
      `Buffer` of exactly `size` (or all remaining at EOF) otherwise; `.read()` with
      no arg returns all buffered data or `null`.
- [ ] Fed by the Phase-2 reactor: an fd0-readable event appends to the stream's
      internal buffer and emits `'readable'`/`'data'`.
- [ ] The synchronous #1653 `process.stdin.read(buf, off)` shim is either kept as a
      distinct legacy path or migrated; document the decision. (Do not silently break
      #1653 consumers.)
- [ ] An end-to-end example program (echo / line-count over stdin) compiles to WASI
      and runs under wasmtime with correct streaming behaviour.

### Phase 4 — Preview 2 `wasi:io/poll` backend (future)
- [ ] An alternative reactor backend targeting `wasi:io/poll` + `wasi:io/streams`
      (Component Model), selected by target flag, with the same Node surface on top.

## Implementation Plan

### Root cause
There is no scheduler loop: `_start` calls the entry then drains microtasks **once**
(`addWasiStartExport`, `src/codegen/index.ts:1998` → `getDrainFuncIdxForWasiStart`,
`src/codegen/async-scheduler.ts:1066`). Timers are rejected at compile
(`rejectTimersUnderWasi`, `src/codegen/index.ts:12665`). I/O is a synchronous
buffer-in shim (#1653, `src/codegen/node-process-api.ts`). The resumable-continuation
substrate (Promise `.then` chains from `async-cps.ts`, microtask queue from
`async-scheduler.ts`) and the `poll_oneoff` subscription marshaller
(`emitWasiSleepMsHelper`, `src/codegen/index.ts:7264`) all exist but are never
composed into a loop.

### Phase 1 changes — scheduler + timers + microtasks

**File: `src/codegen/async-scheduler.ts`**
- Extend `AsyncSchedulerState` (the interface around line 52) with **timer-heap**
  fields, mirroring the existing microtask-queue field pattern (globals for a binary
  min-heap keyed by deadline-ns): `timerHeapGlobalIdx`, `timerCountGlobalIdx`,
  `timerCapGlobalIdx`, and func indices `timerAddFuncIdx`, `timerPopDueFuncIdx`,
  `timerPeekDeadlineFuncIdx`, `runLoopFuncIdx`. Initialise to `-1` in
  `getOrCreateAsyncSchedulerState` (alongside the existing `drainFuncIdx: -1` inits
  ~line 111).
- Add `ensureTimerHeap(ctx)` modelled on `ensureMicrotaskQueue` (line 228): allocate
  a WasmGC struct array (`{deadlineNs: i64, callback: funcref, capture: externref}`)
  + head/count/cap globals, and register `__timer_add(deadlineNs: i64, cb: funcref,
  cap: externref) -> i32(id)`, `__timer_cancel(id: i32)`, `__timer_pop_due(nowNs: i64)
  -> (funcref, externref) or sentinel`, and `__timer_peek_deadline() -> i64` (i64 max
  when empty). Follow the **late-import-shift discipline** noted at the top of
  `async-scheduler.ts` and in CLAUDE.md "addUnionImports": register all func indices
  in dependency order (heap helpers → run-loop) and never push a struct type
  mid-class-collection (memory `project_type_index_shift_and_deadelim`).
- Add `emitRunEventLoop(ctx)` — the driver. Pseudocode (emits WasmGC `Instr[]`):
  ```text
  loop $L:
    call __drain_microtasks            ;; settle all pending Promise reactions
    call clock_time_get -> nowNs        ;; CLOCK_MONOTONIC, reuse #1483 import or add
    ;; fire all due timers (each may enqueue microtasks → next iter drains them)
    block:
      loop:
        call __timer_peek_deadline
        local.tee $d
        i64.const I64_MAX ; i64.eq ; br_if (no timers) -> break to handles-check
        local.get $d ; local.get $nowNs ; i64.gt_s ; br_if (not due) -> break
        call __timer_pop_due(nowNs) -> (cb, cap)
        call_ref $mt_func_type          ;; invoke the timer callback
        drop
        br (re-peek)
    ;; pending-handle check: any timers left?  (Phase 2 also: any fd subs?)
    call __timer_peek_deadline ; i64.const I64_MAX ; i64.ne ; if:
      ;; block until nearest timer via the EXISTING single-clock poll_oneoff path
      local.get $d ; local.get $nowNs ; i64.sub ; (ns→ms) ; call __wasi_sleep_ms
      br $L
    ;; else no pending handles → fall through, loop exits
  ```
  Phase 1 may reuse `__wasi_sleep_ms` (`src/codegen/index.ts:7264`) for the blocking
  wait on the nearest deadline; Phase 2 replaces that single-clock sleep with a
  multi-subscription `poll_oneoff` (fd0 + clock).
- Export a `getRunLoopFuncIdxForWasiStart(ctx)` alongside the existing
  `getDrainFuncIdxForWasiStart` (line 1066). It returns the run-loop func idx when
  **either** the microtask queue **or** the timer heap was registered, else `null`.

**File: `src/codegen/index.ts`**
- `addWasiStartExport` (line 1998): replace the `getDrainFuncIdxForWasiStart` call
  (line 2086) with `getRunLoopFuncIdxForWasiStart`. When non-null, append
  `{op:"call", funcIdx: runLoopIdx}` instead of the bare drain. The run loop itself
  calls `__drain_microtasks`, so this **supersedes** the one-shot drain (do not emit
  both). Keep the bare-drain fallback only for modules that registered the microtask
  queue but no timer heap **and** where emitting the full loop is undesirable — simpler
  to always emit the loop when the queue exists (the loop with zero timers just drains
  once and exits, byte-equivalent in effect).
- Timer detection: today `needsPollOneoff` is set when `setTimeout`/`setInterval`/
  `setImmediate` appear (line 5865). Repurpose this to **also** call
  `ensureTimerHeap(ctx)` + `emitRunEventLoop(ctx)` registration (in the same late
  phase the sleep helper is emitted, ~line 6104) instead of relying on
  `rejectTimersUnderWasi`.
- `rejectTimersUnderWasi` (line 12665): **remove `setTimeout`/`setInterval`/
  `setImmediate`/`clearTimeout`/`clearInterval` from `WASI_REJECTED_TIMER_GLOBALS`**
  for Phase 1 (keep `queueMicrotask` rejection only until its lowering lands in the
  same phase). Leave the function in place for any still-unsupported globals.

**File: timer call-site lowering** (where bare-identifier `setTimeout(...)` is compiled
— likely `src/codegen/expressions/calls.ts`; grep `setTimeout` there). Lower
`setTimeout(cb, ms)` to: compute `deadlineNs = nowNs + ms*1e6`, wrap `cb` (a closure)
into the uniform `$__mt_func_type` `(externref, externref) -> externref` wrapper used
by the microtask queue (reuse `emitMakeContinuationCallback` / the closure→funcref
path in `async-cps.ts`/`closures.ts`), then `call __timer_add`. Return the timer id as
an `f64` (JS `setTimeout` returns a number / Timeout). `setInterval` re-adds itself on
fire (the popped callback re-arms with the same period before invoking).

**File: `src/codegen/context/types.ts`**
- No new top-level ctx fields needed if timer state lives on `ctx.asyncScheduler`
  (preferred — keeps it co-located with the queue). If a flag is needed, mirror
  `wasiPollOneoffIdx` / `wasiPendingSleepMsHelper`.

#### Wasm IR pattern — multi-subscription poll (Phase 2, extends the #1484 marshaller)
The Phase-1 single-clock subscription is already emitted by `emitWasiSleepMsHelper`
(48-byte `subscription_t` at scratch offset 64; see its doc comment at
`src/codegen/index.ts:7244` for the exact field offsets). Phase 2 writes **two**
contiguous subscriptions and passes `nsubs=2`:
```text
;; sub[0] @ scratch+0  = FD_READ on fd 0
;;   userdata(u64)=0; tag(u8)=1 (EVENTTYPE_FD_READ); fd(u32)=0
;; sub[1] @ scratch+48 = CLOCK on CLOCK_MONOTONIC, timeout=nearestDeadline-now
;;   (identical layout to the #1484 clock subscription)
;; poll_oneoff(in=scratch, out=evtbuf, nsubs=2, nevents_out=nev)
;; for i in 0..nev: read event_t.userdata/type at evtbuf + i*32; dispatch
```
Set fd0 non-blocking first: register `fd_fdstat_set_flags(fd, flags) -> errno` and call
it with `fd=0, flags=FDFLAG_NONBLOCK(0x4)` at loop entry.

### Phase 2/3 changes (sketch — spec in full when pulled into a sprint)
- **`src/codegen/node-process-api.ts`** — today `matchProcessStdinRead`/
  `emitProcessStdinRead` implement the synchronous #1653 read. Add the Readable
  surface as shim-backed (`js2wasm:node-process`): the stream object + EventEmitter
  live in library/shim code; codegen only resolves `process.stdin.on/read` to shim
  imports per `feedback_node_apis_via_per_module_shim_not_builtin`.
- **`examples/native-messaging/node-process.wat`** (the shim) — add the readable-stream
  buffering + event dispatch, fed by the reactor's fd0-readable events.
- **`src/runtime.ts`** — extend the `poll_oneoff` polyfill (line 12119) to honour FD_READ
  subscriptions (report fd0 readable from a JS-driven input source) so vitest tests can
  exercise the reactor without a real WASI host.

### Edge cases
- **Zero timers, with microtasks** — loop drains once and exits (Phase-1 byte-effect
  equivalent to today's one-shot drain).
- **`setTimeout(cb, 0)`** — deadline = now; fires only **after** the synchronous
  top-level returns and after the first microtask drain (matches Node).
- **Timer callback schedules another timer / a microtask** — the loop re-peeks the heap
  and re-drains microtasks each iteration, so newly scheduled work runs.
- **`setInterval`** — re-arm on fire; `clearInterval`/`clearTimeout` mark the heap entry
  cancelled (lazy delete on pop) so a fired-but-cleared timer does not re-arm.
- **No pending handles** — loop exits cleanly so `_start` returns and the process exits 0.
- **fd0 EOF (Phase 2/3)** — `fd_read` returns 0 bytes; emit `'end'`, drop the fd
  subscription; if no timers remain, the loop exits.
- **poll_oneoff errno != 0** — surface as a trap or a swallowed retry; do not spin.
- **Late-import index shifts** — register `poll_oneoff`, `clock_time_get`,
  `fd_fdstat_set_flags`, `fd_read` **before** emitting any defined helper that
  references them (the discipline already used at `src/codegen/index.ts:5958`+ for
  `random_get`/`poll_oneoff`/`clock_time_get`), and register the timer-heap struct type
  once, late, per `project_type_index_shift_and_deadelim`.

### Test files to add / update
- `tests/issue-2632-wasi-event-loop.test.ts` (new) — Phase 1: timer ordering,
  microtask-before-timer, nested scheduling, `setTimeout(…,0)` after sync.
- `tests/wasi-timers.test.ts` (#1484) — flip the 8 "rejects under WASI" assertions to
  "compiles and runs".
- `tests/issue-1326.test.ts` / `tests/issue-1326c.test.ts` — must stay green (the run
  loop must be a strict superset of the one-shot drain behaviour).
- `tests/issue-1653-wasi-process-stdin-read.test.ts` — must stay green (Phase 3 must not
  break the legacy synchronous path until/unless it is deliberately migrated).
- Phase 3: an end-to-end stdin-echo example compiled with `--target wasi` and run under
  wasmtime / the runtime polyfill.

## References
- loopdive/js2 **#389** — reporter guest271314: synchronous `process.stdin.read` matches
  no real Node API; Node's stdin is an async Readable on an event loop. This goal is the
  general fix.
- **#2631** — synchronous Native-Messaging host (fd-based `node:fs` readSync/writeSync).
  **Orthogonal**: no event loop; this goal neither blocks nor is blocked by it.
- **#1326 / #1326c** — standalone microtask queue + Promise + `.then` (`async-scheduler.ts`).
- **#1042 / #1373b** — async/await CPS state machine (`async-cps.ts`).
- **#1484** — `poll_oneoff` import + `__wasi_sleep_ms` subscription marshaller; timers
  currently rejected (`rejectTimersUnderWasi`).
- **#1653** — synchronous `process.stdin.read(buf, off)` (the API being superseded).
- **#2524 / #2625** — `js2wasm:node-process` shim + `--link-node-shims` (the per-module
  shim boundary the Node surface should ride on).
