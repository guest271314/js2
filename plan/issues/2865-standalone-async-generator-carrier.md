---
id: 2865
title: "Standalone: no Wasm-native async-generator / for-await carrier — leaks __create_async_generator + Promise_* host imports"
status: in-progress
assignee: ttraenkler/sendev-flatten
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2860, 2864, 2867]
umbrella: 2860
architect_spec: candidate
depends_on: [2864, 2867]
---

# Standalone: async-generator / for-await-of carrier

## Problem

`async function*`, `for await...of`, and async-generator destructuring have no
standalone carrier. They leak `__create_async_generator`, the `__gen_*` family,
and the `Promise_*` microtask imports.

### Impact (measured 2026-06-30) — ~986 standalone-only failures

The largest single cluster by my classifier. Proximate errors are
`illegal cast [in __iterator() ← fn]` / `[in __obj_find() ← __extern_set]`
inside async destructuring + for-await machinery (867 fail, 119 CE).

## Root cause

Async generators compose two missing standalone substrates: the **generator
state machine** (#2864) and the **Promise/microtask** runtime (#2867). An async
generator's `next()` returns a Promise of `{value, done}`; `for await` drives it
through the microtask queue. Neither exists natively in standalone.

## Implementation Plan

**Architecture-scale — `architect_spec: candidate`; depends on #2864 (generator
state machine) and #2867 (Promise carrier).** Do NOT start before both land.

Design sketch (for the architect):

- Reuse #2864's `$GenFrame` state machine; the resume function returns a Promise
  built on #2867's capability instead of a bare `{value,done}`.
- `for await (x of g)`: lower to a microtask-driven loop — `await g.next()`,
  unwrap `{value,done}`, run body, repeat — using the same await-lowering as
  async functions (verify async functions are already native in standalone; if
  they too leak `Promise_*`, that work is #2867).
- Async `yield*` delegates to the inner async iterator with await between steps.

## Test plan

Standalone fail/CE → pass:

- `test/language/statements/for-await-of/**`
- `test/language/statements/async-generator/**`,
  `test/language/expressions/async-generator/**`
- `test/built-ins/AsyncGeneratorFunction/**`, `AsyncFromSyncIteratorPrototype/**`
- `test/built-ins/Array/fromAsync/**`

Full `merge_group` + standalone high-water. Largest cluster but gated on two
predecessors — schedule after #2864/#2867.

## AG0 — host-free `await` unwrap (landed WASI-only; standalone deferred to #2895)

**Scope shipped:** under **`--target wasi`**, `await` now reads the resolved
value from the native `$Promise` carrier host-free; `async f(): Promise<number>
{ return await Promise.resolve(5) }` and async methods run with **zero host
imports** and return the correct value (was NaN, the identity-passthrough bug).

> **#2895 reconcile (2026-06-30) — standalone widening REVERTED, net-neutral.**
> AG0 originally widened `isStandalonePromiseActive` to
> `ctx.wasi || ctx.standalone`, activating the native `$Promise` carrier for
> `--target standalone` too. Ground-truth measurement on the #2384 frame-core
> base proved that widening is a **net regression** on standalone, **not** a
> gain: async standalone sample 134→103 pass (−31); the await+async-function
> area itself 71→42 (−29); **zero** offsetting await win. Root cause: the
> `flags:[async]` test262 harness uses _synchronous settlement_
> (`asyncTest(fn)` calls `fn()` then `$DONE()` with no microtask drain), so an
> async fn returning a native `$Promise` is observed as an undrained struct,
> not a value. The host-free standalone await gain is **coupled to a real async
> drive layer** (result `$Promise` + harness-drainable microtask settlement) =
> **PATH B (#2895)**, and is not bankable by a bounded gate flip. So
> `isStandalonePromiseActive` is reverted to `ctx.wasi` only: standalone returns
> to baseline (net-0, zero regression), WASI keeps the genuine native-`$Promise`
> behaviour + the await NaN-fix. PATH B re-widens the gate (and
> `isStandaloneThenChainNativeActive`) once the drive layer lands.

### Why these decisions (root-cause, not symptom)

Verify-first found the task's starting assumptions were stale on main: the
async-CPS state machine (`async-cps.ts`) is gated **off** for BOTH standalone
and WASI (`function-body.ts`), so async fns are compiled **synchronously** with
their unwrapped return type (`function-body.ts:668`), and `await` was a pure
**identity passthrough** (`expressions.ts`). So `await <a fulfilled $Promise>`
returned the promise OBJECT (externref) where the consumer expected the resolved
value → coerced to f64 = **NaN**.

- **`isStandalonePromiseActive` returns `ctx.wasi`** (`async-scheduler.ts`).
  For WASI (host-free), `Promise.resolve/reject`, the async-fn return wrap, and
  the await unwrap use the Wasm-native `$Promise` carrier instead of the host
  imports. Standalone is intentionally NOT widened here — see the #2895 reconcile
  note above (the harness can't drain native standalone async results without
  PATH B's drive layer).
- **`await` unwraps ONE level of the native `$Promise`** at runtime
  (`emitStandaloneAwaitUnwrap` in `expressions.ts`): a `ref.test (ref $Promise)`
  (non-null) discriminates — a `$Promise` operand yields its `value` field
  (field 1), anything else (a plain value, a null, a non-Promise thenable) passes
  through unchanged. The operand is compiled to its **natural** type (NOT forced
  to `expectedType` — that would coerce a `$Promise` externref to f64/NaN before
  it can be read); non-externref operands (an async call that already returns the
  unwrapped number) pass through.

### Deferred — genuinely-pending awaits → #2895 (AG1 / PATH B)

One-level unwrap does not serve a promise that only settles on a _later_
microtask/timer (async executor, `.then` observed synchronously, `Promise.all`
of pending). Those need true frame suspension (await-on-`$Frame` + microtask
resume) — filed as **#2895**. They were already wrong pre-AG0, so deferring is
not a regression. arch-asyncgen's AG0–AG5 spec lives on `origin/async-gen-2865-spec`.

### Files (AG0)

- `src/codegen/async-scheduler.ts` — `isStandalonePromiseActive` gate extension.
- `src/codegen/expressions.ts` — `emitStandaloneAwaitUnwrap` + the standalone/WASI
  `await` arm.
- `tests/issue-2865-standalone-async-await-unwrap.test.ts` — 7 standalone cases
  (zero-host-import asserted, correct values).
