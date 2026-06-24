---
id: 2632
title: WASI async runtime — event-loop reactor (process.stdin Readable, timers, promise-driven I/O)
status: done
completed: 2026-06-24
assignee: ttraenkler/sdev-2632-readable
sprint: 65
goal: wasi-async-runtime
feasibility: hard
kind: goal
created: 2026-06-23
refs: [389, 2631, 1326, 1326c, 1484, 1653, 2524, 2641, 2642, 2643]
---

> **PHASED ISSUE — Phases 1-3 have LANDED; this issue is now `done`.** Phase 1
> (scheduler + timers + microtasks), Phase 2 (the fd-readiness reactor — multi-sub
> `poll_oneoff` on fd0+timer, non-blocking `fd_read` into an internal stdin
> buffer), and **Phase 3 (the faithful `process.stdin` Node `Readable` —
> string/Buffer chunks, `.on('data'|'end'|'readable')`, `.read([size])` null-on-
> short, `.pause()`/`.resume()`, flowing/paused, EOF, auto-injected import-scoped)**
> are all implemented and merged; the event-loop reactor drives
> `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`/`queueMicrotask` AND a
> real `process.stdin` Readable under `--target wasi`. **Phase 4** (the Preview-2
> `wasi:io/poll` backend) is a SEPARATE deferred follow-up filed as **#2643** — it
> does NOT block closing this goal.

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

### Phase 1 — scheduler + timers + microtasks (smallest viable first slice) ✅ LANDED
- [x] A **run-loop driver** function (`__run_event_loop`) replaces the one-shot
      `__drain_microtasks` call in the WASI `_start` wrapper. It loops:
      drain microtasks → if any timer is due, fire it → if timers remain pending,
      `poll_oneoff` on the nearest deadline → repeat → exit when no pending handles.
- [x] `setTimeout(cb, ms)` / `setInterval(cb, ms)` / `clearTimeout`/`clearInterval`
      compile under `--target wasi` (removed from `WASI_REJECTED_TIMER_GLOBALS`)
      and are driven by the loop via a **timer table**, not a blocking sleep.
- [x] `queueMicrotask(cb)` compiles under WASI and enqueues onto the existing
      microtask queue.
- [x] Ordering: all microtasks drain **before** the first due timer fires; timers fire
      in non-decreasing deadline order; a `setTimeout(…, 0)` fires after sync code and
      after pending microtasks. (Verified under real wasmtime.)
- [x] Existing #1326/#1326c Promise tests still pass; `wasi-timers.test.ts`
      (the #1484 diagnostic) updated from "rejects" to "compiles + runs".
- [x] New `tests/issue-2632-event-loop.test.ts` covering timer ordering,
      microtask-before-timer, nested `setTimeout`, interval+clearInterval, and
      clearTimeout — each compiled `--target wasi` and run under wasmtime.

**Scope boundary hit — top-level `await`**: left rejected/unlowered as the spec
predicted. The CPS machine lowers `await` only inside `async function` bodies;
module-suspending top-level await would need module-init itself lowered to a
state machine. Phase 1 does not need it (top level schedules work synchronously
and returns; the loop then runs), and it is in the test262 skip set. Untouched.

#### Phase 1 implementation notes (WHY, for Phase 2+ maintainers)
- **Timer table, not a binary min-heap.** The spec sketched a binary heap; I used
  **parallel WasmGC arrays** (`deadlines:i64`, `callbacks:funcref`,
  `captures:externref`, `intervals:i64`, `cancelled:i32`) with an O(n) linear scan
  for the earliest live deadline (`__timer_peek_deadline`) and a single-pass
  `__timer_fire_due`. Timer counts are tiny, so O(n)/tick is irrelevant, and a
  linear scan is far less bug-prone than a hand-rolled WasmGC heap. Ids are stable
  slot indices (no compaction on grow), so `clearTimeout(id)`/`clearInterval(id)`
  keep working across a grow; cancellation is a lazy `cancelled[id]=1` flag.
- **The reactor is byte-neutral for non-timer programs.** `__run_event_loop` is only
  registered when the source references a timer/microtask global (`needsTimerHeap`);
  otherwise `_start` keeps the exact `getDrainFuncIdxForWasiStart` one-shot-drain (or
  empty) body. Verified: a `console.log`, a `for`-loop, a `Promise.resolve().then`,
  and a plain function program all produce **byte-identical** Wasm (same SHA256 +
  length) vs the branch base. The run loop with zero timers is also behaviourally a
  strict superset of the one-shot drain (drains once, peeks empty → exits).
- **Index discipline (`project_type_index_shift_and_deadelim`).** The timer heap
  (struct/array types, globals, and the 7 helper funcs `__timer_grow/add/cancel/
  peek_deadline/fire_due`, `__rl_now_ns`, `__run_event_loop`) is registered in the
  **deferred-helper phase** (`emitDeferredWasiHelpers`, after `__wasi_sleep_ms` +
  `clock_time_get`, BEFORE user bodies compile) so the `__timer_add`/`__timer_cancel`
  func indices baked into call sites are final. The per-callback wrapper
  (`__timer_cb_N`) is append-only during body compile (safe). The timer callback
  reuses the microtask queue's uniform `$__mt_func_type` `(externref,externref)->
  externref` signature, so a timer callback and a microtask continuation are
  `call_ref`-compatible; the closure struct itself is stored as the `captures`
  externref and re-cast in the wrapper.
- **`now` = CLOCK_MONOTONIC.** `__rl_now_ns` calls `clock_time_get(1, …)` into linear
  scratch[48..55] and recombines the LE u64 from two i32 loads (the binary emitter
  has no `i64.load`). The blocking wait reuses the existing #1484 single-clock
  `__wasi_sleep_ms` (relative-ms `poll_oneoff`); Phase 2 swaps this for a
  multi-subscription `poll_oneoff` (fd0 + clock).
- **The #1501 timer host-import shim is suppressed under WASI.** `preprocessImports`
  injects a `function setTimeout(cb,ms){ return __timer_set_timeout(cb,ms); }` stub
  into the user source for the **JS-host** path. Under `--target wasi` that stub (a)
  pulls in an unresolvable host import and (b) makes `setTimeout` resolve to a
  user-file declaration, which *defeated the reactor lowering* (the call inlined the
  no-op stub). The fix threads `{ wasi }` into `preprocessImports` and skips the shim
  entirely for WASI. The call-site + detection guards additionally honour a *genuine*
  user `function setTimeout` shadow (decls not all in `.d.ts`) so a real shadow keeps
  its own semantics.
- **`setImmediate` stays rejected.** Its Node "check phase" ordering (after I/O poll,
  distinct from a 0ms timer) is a later-phase concern; only `setImmediate` remains in
  `WASI_REJECTED_TIMER_GLOBALS`.

### Phase 2 — poll_oneoff reactor + non-blocking fds ✅ LANDED
- [x] Set fd 0 non-blocking via `fd_fdstat_set_flags` at loop start.
- [x] The loop builds a **multi-subscription** `poll_oneoff` set: fd0-readable +
      nearest timer deadline (clock). Dispatch the returned `event_t`s: a readable
      fd0 event triggers a non-blocking `fd_read` into the internal stdin buffer;
      a clock event fires the due timer(s).
- [x] EOF on fd0 (`fd_read` returns 0 bytes with the FD_READ event set / `nbytes==0`)
      ends the readable side (drops the fd0 subscription).
- [x] Reactor exits when no pending timers **and** no fd subscriptions remain.

> **Phase 2 builds the substrate only — it does NOT expose `process.stdin`.**
> The internal stdin buffer + the multi-sub reactor are in place; the
> `process.stdin` Readable (`.on`/`.read([size])→Buffer|null`) is Phase 3.
> The internal-buffer access primitive exposed for testing is the
> `__wasiStdinReadByte()` intrinsic (next buffered byte 0..255, or -1 when
> empty), which Phase 3's `.read()` will build on.

#### Phase 2 implementation notes (WHY, for Phase 3+ maintainers)
- **The fd-reactor is a SEPARATE run-loop body, gated on `state.stdinReactor`.**
  `buildRunLoopBody` branches: when the stdin reactor is inactive it emits the
  EXACT Phase-1 single-clock-sleep body; when active it emits
  `buildRunLoopBodyWithFdReactor` (drain fd0 → fire timers → multi-sub poll). The
  Phase-2 globals (`__stdin_nonblock_set/_fd_active/_buf_len/_buf_pos`) and the two
  helpers (`__rl_stdin_drain`, `__rl_poll_fd0_or_clock`) register **only** when the
  reactor is active, BETWEEN `__rl_now_ns` and `__run_event_loop`. So a timer-only
  program keeps Phase 1's exact global table + func-index layout — verified
  **byte-identical** (same len + SHA256) for `timer-only`/`interval-only`/
  `microtask-only` and all non-timer programs, in a 120-file test262 batch (the
  #1968 lesson: byte-diff must be done IN BATCH, not on a 4-program sample).
- **Multi-sub `poll_oneoff` generalises the #1484 single-clock marshaller.**
  `__rl_poll_fd0_or_clock(deadlineNs, nowNs)` writes `subscription_t` **sub[0]** =
  FD_READ on fd 0 (tag=1, fd@+16), and — only when a timer is pending
  (`deadline != I64_MAX`) — **sub[1]** = CLOCK on CLOCK_MONOTONIC (identical layout
  to `emitWasiSleepMsHelper`, timeout = `max(0, deadline-now)`), passes `nsubs=1`
  or `2`, then scans the returned `event_t[]` for a type-tag-1 (FD_READ) record and
  returns 1 (fd0 readable) else 0 (clock fired). The poll scratch lives at offset
  160+ in the page-0 bump zone, ABOVE `__wasi_sleep_ms`'s 64..147 region, so the
  two paths never alias.
- **Non-blocking fd0.** `__rl_stdin_drain` sets fd0 non-blocking ONCE
  (`fd_fdstat_set_flags(0, FDFLAG_NONBLOCK=0x4)`, guarded by `__stdin_nonblock_set`),
  then does a single `fd_read` of available bytes into the internal buffer
  (reusing the page-1 `WASI_STDIN_BUF_START` region from #1653, appending at
  `__stdin_buf_len`). EAGAIN (errno 6) = "no data this tick, NOT EOF"; a 0-byte
  read at a readable fd = EOF → `__stdin_fd_active=0`; any other errno is treated
  as EOF to avoid a spin. The buffer compacts (reset both cursors) once the read
  cursor `__stdin_buf_pos` has consumed everything.
- **Reactor exit.** The fd-reactor tick computes `pending = (peek != I64_MAX) ||
  fd0_active`; it exits only when no timer is pending AND fd0 has hit EOF. So a
  program that just reads stdin to EOF (no timers) terminates cleanly; a program
  with a live timer keeps the loop alive for late stdin.
- **Late-import-shift lockstep (root-cause fix, benefits Phase 1 too).** The
  async-scheduler stores helper func indices as plain numbers on
  `ctx.asyncScheduler` (`runLoopNowFuncIdx`, `timerAddFuncIdx`, `drainFuncIdx`, …).
  A late import landing AFTER helper registration but BEFORE a call site bakes its
  `call` funcIdx (e.g. `__str_concat` pulled in while compiling a
  `setTimeout(()=>console.log("x"+n))` callback, which runs BEFORE the timer's
  now-reader call is emitted) shifted every defined function up by `added` but NOT
  these stored numbers — so `__rl_now_ns` baked one slot too low, hit
  `__timer_fire_due`, and produced "expected i64 but nothing on stack" invalid
  Wasm. Fixed by adding the scheduler func-index map to the lockstep in
  `flushLateImportShifts` (mirrors the `nativeStrHelpers`/`mapHelpers` lockstep,
  #1677/#2162). This was latent in Phase 1 (it dodged the window via the
  `mod.functions` body-walk); the fix makes the stored indices consistent with
  `ctx.funcMap` unconditionally.
- **Polyfill.** `src/runtime.ts`'s `poll_oneoff` now decodes all `nsubs`
  subscriptions and reports an FD_READ event when fd0 has preloaded stdin
  remaining, else the CLOCK event — letting vitest drive the reactor without a
  real OS poll. `fd_fdstat_set_flags` is a no-op ack (the polyfill `fd_read` is
  already non-blocking).
- **Scope.** Phase 2 requires the inline (non-`--link-node-shims`) fd_read path;
  under `--link-node-shims` the reactor keeps the inline `fd_read` import rather
  than the shim's `stdin_read`. Integrating the reactor with the node-process
  shim + the `process.stdin` Readable is Phase 3.

### Phase 3 — process.stdin Readable stream (the deliverable) ✅ LANDED
- [x] `process.stdin` is a real Readable / EventEmitter, provided via **library
      TS code** (NOT codegen builtins): `.on('readable', cb)`, `.on('data', cb)`,
      `.on('end', cb)`, `.read([size]) → string|null` with internal buffering,
      `.pause()`/`.resume()`. Auto-injected import-scoped (only when the program
      references `process.stdin`).
- [x] `.read(size)` returns `null` when fewer than `size` chars are buffered, a
      `size`-char chunk (or all remaining at EOF) otherwise; `.read()` with no arg
      returns all buffered data or `null`.
- [x] Fed by the Phase-2 reactor: each tick the reactor-tick reader hook drains
      fd0 into the stream and emits `'readable'`/`'data'`; `'end'` at EOF.
- [x] The synchronous #1653 `process.stdin.read(buf, off)` form is UNCHANGED — it
      is still rejected by the #2633 compile-error path (it is a hallucinated API).
      The faithful zero/one-arg `.read([size])` is the rewritten library method;
      the two are syntactically distinct (`.read(buf, off)` vs `.read()`/`.read(n)`),
      so no #1653 consumer breaks.
- [x] End-to-end echo / read programs compile to WASI and run under **real
      wasmtime** with correct streaming behaviour
      (`tests/issue-2632-phase3-stdin-prelude.test.ts`).

#### Phase 3 implementation notes (WHY — for maintainers)

**Status: LANDED. The faithful string-chunk `process.stdin` Readable is
auto-injected import-scoped and proven end-to-end over the polyfill AND real
wasmtime. The former blocker (#2641, the native-string finalize-shift that made a
string-building class method emit invalid Wasm under `--target wasi`) is FIXED on
main — re-verified at the start of this work.**

**What landed in this PR.**
- `src/process-stdin-prelude.ts` — `injectProcessStdinPrelude(source)`: a
  pre-parse source transform that, when the program references `process.stdin`,
  (1) **prepends** the faithful string-chunk `__Js2wasmReadable` library +
  `__js2wasm_stdin()` singleton and (2) **rewrites** every `process.stdin`
  property-access to `__js2wasm_stdin()`, returning a {@link PositionMap} so
  diagnostics still report the user's line/column.
- `src/compiler.ts` (`compileSourceSync`, "Step 0a.4") — runs the injection
  between the `define` and CJS-rewrite stages, **gated on `target === "wasi"`**,
  and composes its position map into the pipeline.
- `tests/issue-2632-phase3-stdin-prelude.test.ts` — unit (rewrite + byte-neutral)
  + compiled (polyfill) + real-wasmtime e2e coverage for flowing `data`/`end`,
  paused `read(size)` (null-on-short, EOF flush), and `pause()`/`resume()`.

**WHY a source-prelude prepend + rewrite (not member-access codegen).** The Node
surface rides on **compiled TS library code** over the four Phase-2/3 intrinsics
(`__wasiStdinReadByte`/`Available`/`Eof`/`SetReader`), honouring
`feedback_node_apis_via_per_module_shim_not_builtin` — zero new member-access
codegen. The injection mirrors two in-tree precedents exactly: the #1501
timer-shim **prepend** (`buildTimerShim` + `buildPreprocessPositionMap` at edit
offset 0 with an empty original span) and the #1279 CJS-require **rewrite** (span
replacement + `PositionMap`). Any of the four intrinsics flips `needsStdinReactor`
in `codegen/index.ts`, so the fd0 run-loop reactor wires automatically — the
prelude needs no codegen awareness.

**WHY import-scoped + WASI-only (byte-neutrality).** The injection fires ONLY when
the program (a) targets WASI and (b) references `process.stdin` as a genuine
global property access (a `process.stdin` inside a string literal does NOT count —
the scan is AST-based; a user-declared local `process` suppresses the rewrite).
Otherwise it is a structural no-op: non-WASI never calls the pass; WASI-without-
`process.stdin` gets an identity transform (source byte-identical, identity
position map). Verified: a timer-only / `process.stdout.write` / `process.argv` /
plain WASI program carries NONE of the `__Js2wasmReadable` / `__js2wasm_stdin` /
`$__stdin_reader_hook` markers, and the source is byte-identical. This mirrors the
import-scoped `.d.ts` injection in `checker/index.ts` (#2624) — codegen-level here,
type-level there.

**Faithful semantics (no approximation).** `read([size])` returns `string | null`
(Node's contract), null-on-short in paused mode, the remainder flushed at EOF. The
`pump` hook fires `'readable'` on newly-buffered bytes AND once more at EOF (so a
paused consumer can drain the final partial chunk before `'end'`, matching Node's
end-of-stream `'readable'`). `'end'` fires only after fd0 EOF AND the stream's own
buffer is fully delivered (a paused stream withholds bytes, so EOF alone is not
end-of-read). Flowing mode (`.on('data')`/`.resume()`) emits one chunk per tick;
`.pause()` gates delivery and buffers; `.resume()` flushes immediately (the
reactor may already be at EOF).

**One known constraint — #2642 (filed).** A consumer that **inline-concatenates**
the nullable `read()` result inside the `readable` callback closure
(`while ((x = s.read(3)) !== null) console.log("r:" + x)`) hits a PRE-EXISTING
native-string bug: a class method returning `string | null`, narrowed-and-
concatenated inside a closure, emits invalid Wasm under `--target wasi` (the
`null` arm lowers as i32 where the concat helper wants a string ref). This is
independent of the prelude — reproduced with a plain `R` class, ZERO Phase-3 code
— and is the same native-string finalize/representation family as #2641. Filed as
**#2642**. The idiomatic workaround (narrow then hand to a function:
`function emit(c: string){ console.log("r:" + c); }`) is valid and is what the
Phase-3 tests use. The faithful `read(): string | null` API itself is correct;
only that specific user inline-concat shape is affected.

**Architecture decided + proven.** `process.stdin` is provided as **compiled TS
library code** — a `Readable`/EventEmitter class that pulls bytes from the
Phase-2 internal buffer via the `__wasiStdinReadByte()` intrinsic, NOT codegen
builtins (honours `feedback_node_apis_via_per_module_shim_not_builtin`).
**Reconciliation of the stale spec ref:** the Phase-3 acceptance above says
"provided via the `js2wasm:node-process` shim" — that shim was **RETIRED by
#2633 (PR #1985)**. Phase 3 does NOT resurrect it; the Node surface rides on
**library TS code + the reactor/`node:fs` primitives**. The library is intended
to be prepended as a position-mapped source prelude (the exact mechanism Phase 1
uses for the `setTimeout` shim: `timerShim` in `import-resolver.ts` +
`buildPreprocessPositionMap`), with `process.stdin` rewritten to a library
factory call so `.on/.read/.pause/.resume` are ordinary method calls on the
library class (zero new member-access codegen).

**Reactor ↔ stream wiring — the core, LANDED + PROVEN.** A single **reactor-tick
hook** was added to the fd-reactor run loop (`buildRunLoopBodyWithFdReactor`,
`async-scheduler.ts`): a nullable `$__mt_func_type` funcref global
(`__stdin_reader_hook`) + its captures (`__stdin_reader_cap`). Each tick, AFTER
`__rl_stdin_drain` fills the internal buffer and BEFORE firing timers, the loop
`call_ref`s the hook as `pump(captures, null)` — so callbacks run as LOOP WORK,
not synchronously inside `poll_oneoff` (matches Node "data as loop work"). The
library registers its pump via the new `__wasiStdinSetReader(cb)` intrinsic
(wraps the closure into a `$__mt_func_type` wrapper + captures exactly like a
timer callback). This preserves Phase-2's blocking `poll_oneoff` (no busy-spin)
AND dispatches on readiness. EOF (`__stdin_fd_active==0` && buffer drained) is
queryable via the new `__wasiStdinEof()` intrinsic; buffered-byte count via
`__wasiStdinAvailable()`. The pump emits `'end'` and stops on EOF; `.pause()`/
`.resume()` gate flowing-mode delivery in the library.

  - **Byte-neutrality preserved.** The hook globals + hook call register ONLY
    under `state.stdinReactor` (inside the existing `if (state.stdinReactor)`
    blocks). Timer-only and non-stdin programs are byte-identical to Phase 2
    (verified: the Phase-2 "timer-only does NOT register the fd reactor" test
    still passes; all 21 Phase-1+Phase-2 reactor tests green).
  - **No late-import lockstep change needed** for the hook: it is a GLOBAL index
    (globals are append-only and never shifted by late FUNC imports), not a
    stored func index. The `__wasiStdinSetReader` wrapper reuses the existing
    `emitTimerCallbackWrapper` path, already covered by the #2632 scheduler
    func-index lockstep in `flushLateImportShifts`.

**Proven end-to-end (runtime polyfill + the reactor):**
  - A `Readable` class with `.on('data', cb)` + `.on('end', cb)` driven by the
    reader hook: `"Hi"` → data fires per chunk, `'end'` at EOF; `""` → `'end'`
    only. Correct.
  - The same library with **`number[]` (byte) chunks** — `.on`, `.read(size)`,
    `.pause()`/`.resume()`, flowing/paused, EOF — compiles to VALID Wasm and
    runs correctly. So the FULL faithful semantics ARE expressible over the
    Phase-2 buffer; this is NOT a "semantics don't fit" situation.

**On the former blocker (historical).** Phase 3's substrate PR documented a
native-string finalize-shift bug — a string-building class method emitting invalid
Wasm under `--target wasi` with deferred WASI helpers registered. That bug was
filed as **#2641** (note: an earlier draft of these notes mis-referenced it as
"#2637"; #2637 is an unrelated Promise-capability issue). **#2641 is FIXED and
merged to main** (commit `d14b03b54`), which is what unblocked the faithful
string-chunk library shipped here. Re-verified at the start of this work: a
string-building Readable class method now compiles to valid Wasm on `--target
wasi`.

**Follow-ups.** **#2635** (dual-provider proof for async `node:fs` / `process.stdin`
members) is now UNBLOCKED by this work — flip it from `blocked` to `ready` and
proceed. **#2642** (the inline-concat-of-nullable-method-result-in-closure bug) is
a narrow pre-existing native-string defect, filed for a focused fix + architect
review. **Phase 4** (Preview-2 `wasi:io/poll` backend) is **#2643** (backlog).

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
