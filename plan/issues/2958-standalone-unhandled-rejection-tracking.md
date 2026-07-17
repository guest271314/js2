---
id: 2958
title: "Standalone: unhandled-rejection tracking — report rejected promises with no handler at drain/event-loop exit"
status: blocked
depends_on: [2867]
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, runtime
language_feature: promises
goal: standalone-mode
related: [2867, 2632, 1326]
origin: "2026-07-02 July Fable audit §2 (no unhandled-rejection story on the native carrier)"
---

# #2958 — a rejected $Promise with no reactions vanishes silently

## Problem

The native standalone Promise carrier (`src/codegen/async-scheduler.ts`:
`$Promise` state struct + microtask ring + `__drain_microtasks` /
`__run_event_loop`) has no unhandled-rejection tracking: a promise that
settles rejected with an empty callback list is simply garbage — the
program exits 0 with the error swallowed. Host mode inherits the JS host's
reporting; standalone has nothing. This both diverges from spec-required
HostPromiseRejectionTracker observability and hides real failures in
standalone runs (a debugging hazard for every carrier issue).

## Approach

Mirror Node's default behavior at the natural exit points:

1. Track: on reject with empty reactions, append the promise to a
   `$rejectedUnhandled` list; on later `.then/.catch` attach, remove it.
2. Report: at the end of `__drain_microtasks` when the ring is empty (and
   at `__run_event_loop` termination), if the list is non-empty, print
   `Unhandled promise rejection: <stringified reason>` via the existing
   fd_write path (reuse #2962's payload stringification when it lands;
   fall back to the tag/typeof classifier until then) and set a nonzero
   exit code from `_start`.
3. Keep it cheap: no per-turn scanning; list ops are O(1) at settle/attach.

## Acceptance criteria

- `Promise.reject(new Error("x"))` with no handler: standalone binary
  prints the report and exits nonzero; adding `.catch` silences it.
- Late attach within the same drain (reject → microtask → attach) does NOT
  report (matches JS semantics for same-turn handling).
- No behavior change in host mode; host-free floor net-positive or neutral.

## Deferral note (2026-07-02)

Deferred after an initial measure-first sizing pass. Two reasons:

1. **Mis-sized S → M.** The frontmatter `horizon: s` understates the work.
   Unhandled-rejection tracking requires a `$Promise` struct-layout change
   (an `unhandled` flag + a list-link field for the intrusive
   `$rejectedUnhandled` list), plus new logic at the settle/attach sites and
   at both exit points (`__drain_microtasks` empty-ring and `__run_event_loop`
   termination). That is an M, not an S.

2. **Contended core file.** `src/codegen/async-scheduler.ts` is under active
   edit by 6+ concurrent branches doing Promise-carrier work. Landing a
   struct-layout change here now would collide heavily.

**Recommendation:** sequence this after the carrier work settles — specifically
after #2867 / #2959 land — then re-scope as `horizon: m` and reclaim. Claim was
released on the `issue-assignments` ref; `status` left `ready`.

## Implementation Plan (banked 2026-07-03, dev-standing-3)

A second, independent measure-first pass (2026-07-03) reached the same verdict —
this is an **M**, not an **S**, and the sequencing gate **still holds**: #2867
is `in-progress` and #2959 is `ready`, so `src/codegen/async-scheduler.ts` is
still actively churning. **Do not implement until #2867 lands.** What follows is
the execution-ready spec so the next window moves fast once the file settles.

### Gating reality (important — corrects the title's "standalone")

The native `$Promise` carrier is **`ctx.wasi`-gated**, not `ctx.standalone`:
`isStandalonePromiseActive()` returns `ctx.wasi === true`
(async-scheduler.ts ~L3298), and `emitStandalonePromiseThen` /
`Promise.reject` / `__drain_microtasks` only fire on that path. So this feature
targets **`--target wasi`** (where `fd_write` + `proc_exit` + `_start` already
exist). **Host mode is byte-inert by construction** — host never registers
`$Promise` (`host ? -1 : getOrRegisterPromiseType(ctx)`, async-frame.ts L1116),
so no host-lane sha256 risk.

### Data model

- **`$Promise` struct** (`getOrRegisterPromiseType`, async-scheduler.ts ~L258):
  append two fields — `handled: i32 (mut)` and `unhandledNext: externref (mut)`.
  Appending keeps existing `fieldIdx` 0/1/2 (`state`/`value`/`callbacks`) stable,
  so every current `struct.get/set` stays valid. **Mirror the append in the
  `ctx.structFields.set("$Promise", …)` block right below** (both the
  `mod.types.push` and the mirror).
- **Global `__unhandled_head: externref`** (init `ref.null.extern`), registered
  next to the microtask globals (~L400). Intrusive singly-linked list head.

### Emit sites (all in async-scheduler.ts unless noted)

1. **Reject settle** — `buildPromiseSettleBody`, **REJECTED variant only**
   (`settledState === PROMISE_STATE_REJECTED`). After callbacks are read into
   `$callbacks` (L868–872), guard `ref.is_null($callbacks)`: if null (no
   handler at settle) → `promise.unhandledNext = __unhandled_head;
__unhandled_head = promise` (O(1) push). The callback-drain loop below is a
   no-op when callbacks is null, so ordering is safe.
2. **Late attach ("handle")** — `emitStandalonePromiseThen`, the **already-
   rejected receiver** branch (the inner `then:` enqueuing `rejectWrapperFuncIdx`,
   ~L3240): also emit `promise.handled = 1` (`struct.set` fieldIdx 3). A pending
   promise that later rejects **with** callbacks never enters the list, so no
   marking is needed on the pending or fulfilled branches.
3. **Report fn `__report_unhandled_rejections()`** (new): walk `__unhandled_head`;
   for each node with `handled == 0`, write the diagnostic to stderr and set a
   local "any-unhandled" flag; after the walk, if the flag is set, `proc_exit(1)`.
   Minimal-correct message: a **constant** `"Unhandled promise rejection\n"` via
   `wasiAllocStringData(ctx, msg)` → `{offset,length}` →
   `__wasi_write_string_stderr(offset, length)` (exact call shape at
   builtins.ts L2710-2714). Per-reason stringification is **deferred to #2962**
   (fall back to the constant / the tag+typeof classifier until it lands) — this
   keeps the slice bounded and still satisfies AC1/AC2.
4. **Wire into `_start`** — `addWasiStartExport` (index.ts ~L2573): after the
   `runLoopFuncIdx`/`drainFuncIdx` call is pushed to the `_start` body, push
   `call __report_unhandled_rejections`. Report **only at `_start` end** (program
   exit), NEVER inside `__drain_microtasks` itself — a mid-program drain must not
   report or exit.

### HAZARD — late-import funcIdx shift (#2642 / the memory `*_funcidx_desync` cluster)

`__report_unhandled_rejections` references `__wasi_write_string_stderr` **and**
`proc_exit`, which are only registered when `console.error` / `process.exit`
are otherwise used. When this feature is active you MUST (a) **ensure both are
registered** (`emitWasiWriteStringStderrHelper` at index.ts L7629; the WASI
`proc_exit` import from `registerWasiImports`), and (b) **resolve their funcIdx
BY NAME at emit time** — never cache an index across an `ensure*` that adds a
late import. Emit the report body after all imports are fixed, or repoint by
name (`ctx.funcMap.get(...)`) at finalize.

### Test (`tests/issue-2958.test.ts`)

WASI-compile + run under wasmtime (or the standalone harness):

- `Promise.reject(new Error("x"))` with no handler → **nonzero exit** + a stderr
  line. (AC1)
- same but with `.catch(() => {})` → exit 0, no line. (AC2)
- reject → microtask → late `.catch` within the same drain → **no** report. (AC3)

### On claim: re-scope `horizon: s → m` in the frontmatter.

## Unified-spec ratification (architect, 2026-07-04)

The banked plan above is **RATIFIED as-is** as slice **P-6** of the unified
Promise semantics spec (**#2623 §P5** — unhandled rejection; see §P7 for the
slice queue). Two additions from the spec, both cheap:

1. The resolve-value REJECT adoption arm (`__then_identity_reject`) settles
   via `__promise_reject` and therefore inherits the tracking with no extra
   code — assert that in the tests (a chain `p.then(...)` whose adopted inner
   rejects unhandled must report on the DERIVED promise).
2. Coordinate with **#2623 §P3 J-2 (slice P-1)**: the settle-body callback-
   list reversal only runs on non-null lists, so the "callbacks null at
   settle → push onto `__unhandled_head`" check is unaffected — but land P-1
   and P-6 serially (same `buildPromiseSettleBody` region).

**Sequencing gate re-checked 2026-07-04: OPEN.** #2959 is done and #2867's
remaining gaps (#2906 slices 3d + widen) live in async-cps/async-frame, not
the scheduler — the `async-scheduler.ts` churn this was deferred on has
settled. Claimable (Opus, `horizon: m`).
