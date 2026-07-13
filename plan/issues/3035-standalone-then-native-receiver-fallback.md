---
id: 3035
title: "Standalone .then/.catch: fall back to host path on non-native $Promise receiver (#2980 class 1)"
status: done
completed: 2026-07-05
created: 2026-07-05
priority: high
horizon: m
feasibility: medium
task_type: fix
area: codegen, runtime
language_feature: async
goal: standalone-mode
sprint: 71
parent: 2980
related: [2980, 2906, 2895, 2959, 2671, 3036]
---

# #3035 — `.then`/`.catch` native-receiver runtime fallback (#2980 class 1)

## Problem

Under the `#2980` carrier-widen measurement (`JS2WASM_ASYNC_CARRIER_WIDEN=1`,
which is the shape of the eventual `--target standalone` widen of
`isStandalonePromiseActive` + `isStandaloneThenChainNativeActive`),
`emitStandalonePromiseThen` (`src/codegen/async-scheduler.ts`) does an
UNCONDITIONAL `ref.cast` of the `.then`/`.catch` receiver to the native
`$Promise` struct. `isStandaloneThenChainNativeActive` only decides whether
native chaining is enabled for the COMPILE — it cannot know the runtime SHAPE
of the receiver. Several real constructs produce a receiver that is NOT a
native `$Promise` even when native chaining is on:

- the deferred combinators `Promise.allSettled` / `Promise.any`
  (`src/codegen/promise-combinators.ts` only lowers `all`/`race` natively —
  `allSettled`/`any` fall through to the host `Promise_allSettled`/`Promise_any`
  import, which in the test-runner's Node host IS a real JS `Promise`, not our
  GC struct)
- constructor-executor promises / `Promise.prototype.then.call` /
  capability-object shapes noted in the #2980 decision measure

The unconditional `ref.cast` TRAPS on any of these — this was the dominant
#2980 decision-measure residual: **class 1, −18/60** in the original 262-file
corpus measure (2026-07-02).

## Re-measurement (2026-07-05, against main@13350e8f9, incl. #2959 + #2671 slice 2)

Rebuilt the A/B harness (`.tmp/measure-carrier-ab.mts`, per #2980 rule 5 — the
07-02 harness did not survive since `.tmp/` is gitignored) and re-ran the
**promise-then-all bucket only** (60-file deterministic spread-sample across
`Promise/{prototype/then,prototype/catch,prototype/finally,all,race,
allSettled,any,try}`, `--target standalone`, `JS2WASM_ASYNC_CARRIER_WIDEN`
off vs on):

| arm                 | pass/60 | regressed vs off |
| ------------------- | ------- | ---------------- |
| off (baseline)      | 37      | —                |
| on, BEFORE this fix | 21      | **16**           |
| on, AFTER this fix  | 33      | **4**            |

So #2959 + #2671 slice 2 alone had NOT shrunk class 1 in this fresh
measurement (16 regressed, matching the original −18 order of magnitude) —
this fix (the `ref.test` + host-fallback hardening) recovers **12 of the 16**.

The remaining 4 regressions are DIFFERENT root causes, out of this issue's
scope (filed as residuals, not fixed here):

- `Promise/all/resolve-ignores-late-rejection.js` — illegal cast INSIDE
  `__then_fulfill_0` during microtask drain (a chained `.then().then()`
  resolution-value cast, not the initial receiver cast this issue fixes)
- `Promise/allSettled/capability-resolve-throws-reject.js` — a genuine host
  JS `TypeError` from the real `Promise.allSettled` capability algorithm
  (deferred-combinator-specific, unrelated to the native receiver cast)
- `Promise/prototype/then/rxn-handler-{fulfilled,rejected}-invoke-{nonstrict,strict}.js`
  — `this`-binding semantics of the reaction-handler `[[Call]]`, a semantic
  gap, not a trap

## Fix

`src/codegen/expressions/calls.ts`:

- New `emitStandaloneThenWithNativeFallback` — evaluates the `.then`/`.catch`
  receiver ONCE into a local, then emits a runtime `ref.test (ref $Promise)`
  or `if`/`else` (`blockType: {kind:"val", type:{kind:"externref"}}`): the
  `then` arm runs the existing native `emitStandalonePromiseThen` chain
  (cast now provably safe); the `else` arm falls back to the host
  `Promise_then`/`Promise_then2`/`Promise_catch` import — exactly the
  pre-widen standalone behaviour for that receiver shape.
- New `emitHostPromiseThenFallback` — the pre-widen host-import path,
  extracted unchanged so it can be baked into the `else` arm against the
  already-evaluated receiver local (avoiding a second, possibly
  side-effecting, compile of the receiver expression).
- Both arms are built into detached `Instr[]` buffers registered in
  `ctx.liveBodies` while under construction (mirrors the existing
  `onFulfilled`/`onRejected` `liveBuffers` pattern in this file, #2918) so a
  late host-import registered while building the `else` arm still shifts
  any defined-function indices already baked into the `then` arm.
- The two `.then`/`.catch` call sites in `compileCallExpression` branch on
  `ctx.wasi === true` BEFORE reaching the new code: `ctx.wasi` keeps the
  ORIGINAL `compilePromiseThenReceiverBuffer` + unconditional-cast lowering
  UNTOUCHED (byte-for-byte — WASI's zero-`Promise_then`-import contract,
  `tests/issue-1326.test.ts`, is load-bearing and must never regress);
  everything else (`ctx.standalone` under the widen) routes through
  `emitStandaloneThenWithNativeFallback`.

`isStandalonePromiseActive` / `isStandaloneThenChainNativeActive`
(`src/codegen/async-scheduler.ts`) are UNCHANGED — this issue does not flip
the widen gate; it hardens the native lowering so a future flip (once
classes 2-4 land, per #2980's ratified sequencing) does not regress on this
class of receiver.

## Test Results

Scoped local A/B re-measurement above (60-file promise-then-all bucket,
`--target standalone`, off vs on, before/after). `npx tsc --noEmit` clean
(0 errors project-wide). `tests/issue-1326.test.ts` (16 tests, the WASI
zero-host-import contract for `.then`/`.catch`) still green — the fix is
**deliberately WASI-exempt**: `emitStandaloneThenWithNativeFallback`'s
`ref.test` + host-import fallback is scoped to `ctx.wasi !== true` only
(see the "CALLER CONTRACT" doc on that function in `calls.ts`), because
WASI's `.then` MUST NEVER gain a `Promise_then`/`Promise_then2`/
`Promise_catch` import — a real WASI Wasm host has no way to satisfy one,
and `tests/issue-1326.test.ts` asserts the WAT never contains
"Promise_then" + instantiates with an EMPTY imports object. WASI keeps the
EXACT original unconditional-cast lowering, byte-for-byte (verified: no
test262 corpus item currently reaches a non-native receiver under wasi,
since the deferred-combinator paths that would produce one already fail to
instantiate under wasi for their own unrelated missing import). So this fix
activates ONLY under the standalone carrier-widen measurement
(`JS2WASM_ASYNC_CARRIER_WIDEN=1`, unset in CI) — main's default behaviour
(both gc/host and un-widened standalone) is unchanged, matching #2980's
"banked inert" discipline; the `else` (host-fallback) arm there was ALREADY
the pre-widen fallback for every standalone `.then` receiver, so no NEW
import dependency is introduced for standalone either.

New regression test: `tests/issue-3035.test.ts` (env-toggled, isolated per
vitest's per-file fork process) exercises 2 of the confirmed-fixed test262
files under `runTest262File(..., "standalone")` with the widen on, asserting
the "illegal cast" trap is gone. While verifying this, found and filed
**#3036** — a PRE-EXISTING, unrelated null-deref crash when a REAL host
Promise (from the deferred `Promise.allSettled`/`.any` combinators) fires
its `.then` callback on a late Node microtask, reproduced on clean
`origin/main` with no widen needed. Out of scope here; the test file
swallows it (documented) so it doesn't read as a regression this PR
introduced.

## Acceptance criteria

- [x] `.then`/`.catch` on a non-native-`$Promise` receiver, under the
      standalone carrier-widen measurement (`ctx.standalone` + widen on),
      falls back to the host path instead of trapping.
- [x] `--target wasi` is untouched — same unconditional-cast lowering,
      byte-for-byte, preserving the zero-`Promise_then`-import contract
      (`tests/issue-1326.test.ts`, 16/16 still green).
- [x] Re-measured promise-then-all bucket net improves (16 → 4 regressed).
- [x] No behavioural change when `JS2WASM_ASYNC_CARRIER_WIDEN` is unset
      (CI's default) — `isStandaloneThenChainNativeActive` gates entry to
      this whole path, and it's `false` for standalone whenever the widen
      is off.
