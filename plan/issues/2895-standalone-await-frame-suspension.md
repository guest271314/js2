---
id: 2895
title: "Standalone: genuinely-pending await needs true frame suspension (AG1 / PATH B) — await-on-$Frame + microtask resume"
status: ready
created: 2026-06-30
priority: medium
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: Backlog
horizon: xl
related: [2864, 2865, 2867, 2367]
umbrella: 2860
architect_spec: authored
depends_on: [2865]
---

# Standalone: true async-frame suspension for genuinely-pending awaits (PATH B)

## Context

#2865 AG0 (PATH A) shipped the host-free **synchronous-settlement** subset:
under `--target standalone`/WASI, `await` now unwraps one level of the native
`$Promise` carrier (`expressions.ts` `emitStandaloneAwaitUnwrap`) and
`isStandalonePromiseActive` covers `ctx.standalone`, so `await Promise.resolve(x)`,
`await <literal>`, and `await <a sync-fulfilled promise>` run host-free with
correct values (no NaN). Async functions are still compiled **synchronously**
(the CPS state machine is gated off for standalone/WASI in `function-body.ts`).

## Problem (what AG0 does NOT cover)

A **genuinely-pending** await — a promise that only settles on a _later_
microtask/timer (executor that resolves async, `await fetch()`-style I/O,
`Promise.all` of pending promises, `.then` chains observed synchronously) —
cannot be served by one-level unwrap: the value is not present during the
synchronous body execution. AG0 returns the pending `$Promise.value` (null /
stale) for these. They were already wrong pre-AG0, so AG0 is not a regression,
but it does not fix them.

## Root cause / design (PATH B)

Build a real resumable async frame, host-free:

- Extend the #2864 `$Frame` br_table state machine with `await` as an additional
  **suspend-kind** (the AG2 "await-on-`$Frame` convergence"): at an await,
  spill live locals, register a reaction (continuation funcref + frame capture)
  on the awaited `$Promise`'s reaction list, and return the result `$Promise`.
- Rewrite `async-cps.ts` to consume/produce the **native** `$Promise` + the
  existing microtask ring (`async-scheduler.ts`) instead of the host
  `Promise_resolve`/`Promise_then2`/`__make_callback` imports.
- Microtask drain resumes the frame at the saved state with the settled value.
- Async functions then return real `$Promise`s even under standalone.

Reconcile the two existing substrates: the wasi/standalone-gated `$Frame`
(`generators-native.ts`) and the microtask/Promise machinery
(`async-scheduler.ts`, which today has no async-function frame driver).

## Architect spec

arch-asyncgen authored an AG0–AG5 spec that landed on a side branch (not main):
**`origin/async-gen-2865-spec`**. Pull the design from there (or re-spec)
before implementing PATH B.

## Test plan

- `test/language/expressions/await/**`, `test/language/statements/async-function/**`
  (the pending-await shapes AG0 leaves wrong).
- `test/built-ins/Promise/**` `.then`/`all`/`race` observed across a microtask.
- Full `merge_group` + standalone high-water. Sequence after #2865 AG0 (landed).

Also unblocks #2367 (native Promise carrier) and feeds #2865 (async generators).

## Implementation Plan (PATH B — grounded spec, sendev-flatten 2026-06-30)

Grounded against current `main` (incl. #2384 frame-core) + verified by the #2865
AG0 reconcile measurement. **THE async unlock**: every standalone async gain —
the host-free await win AND the ~986 async cluster — gates on this drive layer.
A bounded gate flip cannot bank it (proven: see #2865 AG0 note — the broad
`isStandalonePromiseActive=standalone` netted −31 because the `flags:[async]`
test262 harness can't drain a native async result without this layer).

### Why a drive layer is mandatory (root cause, measured)

The `flags:[async]` harness (`tests/test262-runner.ts` `asyncTest(fn)`) calls
`fn()` then `$DONE()` **synchronously, with no microtask drain**, and observes
`test()`'s return. So for standalone async to be _observable_ it must EITHER (a)
settle synchronously into a value the harness reads, OR (b) the harness must
drain microtasks after `test()`. PATH B does both: async fns return a real
`$Promise`, AND the runner drains `__drain_microtasks` for `flags:[async]`
standalone tests before reading the settle result. **The runner-drain hook is a
required deliverable of slice 1** (without it even a correct drive layer scores
0 on the harness — that is the trap AG0 fell into).

### Reuse (do NOT fork the substrate)

- **`frame-core.ts`** — the `$AsyncFrame` state struct satisfies `FrameLayout`:
  `STATE_FIELD`(0,i32 br_table selector), `SENT_FIELD`(1, the settled awaited
  value delivered on resume), `MODE_FIELD`(2), `ABRUPT_FIELD`(3),
  `ERROR_FIELD`(4, rejection reason), params at `PARAM_FIELD_OFFSET`(5), then
  live-across-await spills. Use `storeSpills` / `setStateInstrs` /
  `setStateFieldFromLocal` / `defaultSpillInstr` verbatim.
- **`async-scheduler.ts`** — `getOrRegisterPromiseType` ($Promise = {0:state i32,
  1:value externref, 2:callbacks externref linked-list of `$PromiseCallback`});
`PROMISE*STATE*{PENDING,FULFILLED,REJECTED}`; the microtask ring
(`**microtask_enqueue(funcref,externref,externref)`/`**drain_microtasks`);
  the existing settle+callback-drain sequence (~L821-872). Reuse the settle path.
- **`generators-native.ts` `ensureNativeGeneratorResumeFunction` (L1781)** — the
  br_table resume-fn builder PATH B mirrors: placeholder-slot reservation BEFORE
  body emit (funcIdx stability — late-import-shift class #1677/#1809/#1899),
  param+spill load from struct into locals, br_table over `STATE_FIELD`.

### Slice 1 — ONE genuinely-pending await in a plain async fn, host-free

1. **`$AsyncFrame` builder** (new `async-frame.ts`, mirrors generator
   `buildResumeInfo`): per-async-fn state struct (FrameLayout) + an
   `AsyncFrameInfo` carrying `stateTypeIdx`, `resumeFuncIdx`, spill metadata,
   and the result-`$Promise` field index.
2. **`__async_resume_f<name>(frame) -> void`** (mirror `ensureNativeGenerator­
ResumeFunction`): reserve slot first; load params+spills; **br_table over
   `STATE_FIELD`** to each continuation. Segment 0 = entry. Each segment runs to
   the next await or to completion.
3. **await-suspend lowering** (replaces the AG0 one-level unwrap when
   `isAsyncDriveActive(ctx)` — a NEW predicate, standalone||wasi):
   `assimilate(operand)` → if `ref.test ($Promise)` and state==PENDING:
   `storeSpills` + `setState(resumeIdx)` + register a reaction
   (`__async_step_f` funcref + this frame) onto the promise's callbacks list +
   `return`. If already FULFILLED: read `value`, jump to continuation inline
   (fast path). If REJECTED: set MODE_THROW + ERROR_FIELD, branch to throw path.
4. **`__async_step_f(frame, settledValue)`** microtask adapter: store
   `settledValue` into `SENT_FIELD`, call `__async_resume_f<name>(frame)`. This
   is the funcref enqueued on the microtask ring / promise reaction.
5. **settle-on-completion**: at async-fn `return v`, settle the frame's result
   `$Promise` FULFILLED+`v` and drain its callbacks (reuse async-scheduler
   settle). At `throw e`, settle REJECTED+`e`.
6. **call-site**: `f()` allocs the `$AsyncFrame` (params spilled into fields),
   creates the pending result `$Promise`, calls `__async_resume_f<name>` once
   (runs segment 0 until first real suspension), returns the result `$Promise`.
7. **runner drain hook** (`tests/test262-runner.ts`): for `flags:[async]`
   standalone/wasi tests, after `test()` call the module's `__drain_microtasks`
   export (already emitted by async-scheduler) before reading the settle. REQUIRED
   for any harness credit.
8. **re-widen the gates**: `isStandalonePromiseActive` and
   `isStandaloneThenChainNativeActive` (both `ctx.wasi`-only after the #2865 AG0
   reconcile) widen to include `ctx.standalone` ONLY once 1-7 land and the drive
   layer makes results observable — flip them together, never piecemeal (the
   piecemeal flip is exactly the AG0 −31).

### Verify-first discipline (NON-NEGOTIABLE — the AG0/−601/−2469 lesson)

- Build on CURRENT `main` (incl. #2384). Merge `upstream/main` first.
- Measure with the corpus `wrapTest`/`runTest262File(...,"standalone")` on REAL
  failing test262 paths (async-function/dstr, class async methods,
  `Promise.all().then` chains, async-generator/dstr) — NOT synthetic snippets.
- Compare merged-HEAD vs `upstream/main` baseline per-file (the harness in
  `.tmp/probe-perfile.mts` from the AG0 reconcile is a ready template): require
  **NET-POSITIVE**, gc-lane unchanged, and the full `merge_group` standalone
  report net-positive (the authoritative gate). Commit incrementally.
- Slice 1 acceptance: a plain async fn with ONE genuinely-pending await
  (executor that resolves on a later microtask) compiles `--target standalone`
  host-free (`result.imports` empty), resumes via the drive layer, and the
  harness (with the drain hook) reads the correct settled value.

### Sizing

`horizon: xl`. Slices 1-8 above; slice 1 is the minimal end-to-end. Start at a
FRESH budget window (a full per-agent share) — do not begin late in a draining
window (the XL would strand at the freeze). PR1 (#2384 frame-core) and the #2865
AG0 reconcile (PR #2380) are the landed predecessors.
