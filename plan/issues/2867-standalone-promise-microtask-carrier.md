---
id: 2867
title: "Standalone: Promise / async microtask leaks Promise_resolve/reject/then + __make_callback host imports"
status: in-progress
assignee: ttraenkler/sendev-carrier
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 1326]
umbrella: 2860
architect_spec: candidate
---

# Standalone: Wasm-native Promise / microtask carrier

## Problem

Promise construction and `.then`/`.catch`/`.finally`, plus async-function await
points, leak `env::Promise_resolve`, `Promise_reject`, `Promise_then`,
`Promise_then2`, and `__make_callback` to the JS host. Under standalone there is
no host microtask queue.

### Impact (measured 2026-06-30) — ~375 standalone-only failures (non-generator)

`Promise_then2` 766, `Promise_resolve` 788, `Promise_reject` 809,
`__make_callback` 1,198 across the gap (overlapping with async-generator #2865);
~375 have Promise/async as the dominant blocker once generators are excluded
(231 fail, 144 CE). (#1326c began standalone microtask/then work — verify what
landed.)

## Root cause

No standalone microtask queue + Promise state machine. Needs:
- a native `$Promise` struct (state: pending/fulfilled/rejected, value, reaction
  list).
- a native **microtask queue** drained at top-of-job / after the main module
  body (a Wasm-side ring buffer of pending reactions).
- `await` lowering in async functions that suspends the async frame (shares the
  resumable-frame machinery with #2864 generators) and resumes from the
  microtask drain.
- `Promise.resolve/reject/all/race/allSettled/any` as native statics.

## Implementation Plan

**`architect_spec: candidate`** — overlaps the generator-frame design (#2864).
Recommend the architect design the **resumable-frame substrate once** and share
it between async functions, generators, and async generators. Check #1326c
(`1326c-microtask-queue-and-promise-then-standalone.md`) for the partial
microtask work already present before re-deriving.

Sketch:
- `$Promise` + microtask ring in the object-runtime; drain entry called after
  module main + at each await resume.
- Replace the `Promise_*`/`__make_callback` host-import emission sites (search
  `src/codegen/**` for these names) with calls into the native carrier under
  `ctx.standalone`.
- `then`/reaction scheduling enqueues a native reaction record (closure +
  capability) instead of `__make_callback`.

## Test plan

Standalone fail/CE → pass:
- `test/built-ins/Promise/**` (resolve/reject/then/finally/all/race/allSettled/any)
- `test/language/expressions/await/**`, `test/language/statements/async-function/**`

Full `merge_group` + standalone high-water. Sequence before async generators
(#2865 depends on this + #2864). Preserve the #2375 caution: Promise proto
value-read path must not collide with runtime async-capability state (the
null-deref noted in property-access.ts:736).

## Implementation notes — Gap 1 LANDED (recursive thenable assimilation), sendev-carrier 2026-06-30

This is the **carrier-completion track** (the blocking half of the standalone
async unlock). The async-frame **drive layer** (#2895 slices 1a–1c, PRs
#2393/#2394) is done and host-free-validated on `--target wasi`; the standalone
count-move is gated on completing the native `$Promise` carrier so the slice-1d
gate-widen (`isStandalonePromiseActive` + `isStandaloneThenChainNativeActive` →
`standalone`) stops regressing. sendev-asyncdrive's A/B/C isolation proved the
drive layer alone = 0 regression and the broad carrier widen = −16 (async-function
74) / −29 (150-sample cluster); the carrier gaps are the cause.

**Gap 1 of 5 — recursive thenable assimilation in native `.then`/`.catch`.** The
dominant regressor (e.g. `language/statements/async-function/returns-async-function.js`:
`.then(retFn => retFn())` must settle with the inner value `1`, not the promise
object). Two coupled fixes, BOTH gated on the native-`$Promise` carrier
(`isStandalonePromiseActive`, wasi-only today → widens to standalone in lockstep
at slice 1d), so the default gc/host lane **and** the still-host-backed standalone
lane are byte-unchanged (the −16/−29 guard's "gc-lane unchanged" requirement):

1. `src/codegen/async-scheduler.ts` — new `__promise_resolve_value(promise, value)`
   runtime helper implementing the spec "Resolve(promise, value)" step: if `value`
   is a native `$Promise`, the chained promise ADOPTS its eventual state
   (FULFILLED → enqueue identity-fulfill reaction with `inner.value`; REJECTED →
   identity-reject; PENDING → prepend a `$PromiseCallback` reaction onto
   `inner.callbacks`) via a `caps{callback:null, chained:promise}` capture;
   otherwise it fulfils directly (drop-in for `__promise_fulfill`). The `.then`/
   `.catch` **handler** wrappers and the identity-fulfill passthrough now settle
   through it; because identity-fulfill itself routes back through resolve-value,
   a chain of promises-returning-promises is assimilated **recursively**. Reject
   reasons are never assimilated (identity-reject stays a direct reject). FuncIdx
   reserved up-front (slot `base+4`) for late-shift safety.
2. `src/codegen/closures.ts` — root cause of the corruption: a NON-async closure
   whose return type is `Promise<T>` (a `.then` handler `v => Promise.resolve(...)`)
   had `resolveWasmType(Promise<T>)` unwrap it to `T` (f64), coercing the returned
   `$Promise` externref to **NaN inside the body** before the settle site ever saw
   it. Now, under the carrier, such a closure resolves to `externref` so the real
   `$Promise` reaches `__promise_resolve_value`.

**Verification** (`tests/issue-2867.test.ts`, host-free wasi, `__drain_microtasks`):
inferred + explicit-`Promise<number>`-annotated + recursive-pending-inner handler
returns all adopt (→ correct value, was NaN); plain non-promise chains unchanged.
gc + standalone lanes proven inert (carrier-gated; `ensurePromiseSettleFunctions`
unreached without the native `.then` path). Typecheck clean, valid Wasm. The
pre-existing `tests/promise-combinators.test.ts` 2-failures reproduce on clean
`upstream/main` (gc/host `Promise.race` runtime shim — not this change).

**Remaining carrier gaps (still deferred, each measured vs the −16/−29 guard before
the slice-1d widen):** 2 async-fn throw→reject routing · 3 try/finally-across-await
(drive-layer-coupled, #2895) · 4 `Promise.all`/`race`/`allSettled`/`any` native
combinators · 5 `for-await-of`/async-generator native drive (drive-layer-coupled).
Do NOT widen the carrier gates until all gap fixes land and the corpus measures
net-positive. Gaps 3 & 5 touch the #2895 drive layer (owned by sendev-asyncdrive)
— coordinate, don't fork.
