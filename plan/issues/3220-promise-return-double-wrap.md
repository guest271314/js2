---
id: 3220
title: "Standalone: native $Promise loses struct identity through a Promise-returning call consumed as a thenable (double-wrap)"
status: done
assignee: ttraenkler/opus-promiserep
created: 2026-07-13
completed: 2026-07-13
priority: medium
feasibility: hard
task_type: fix
area: codegen
goal: standalone
sprint: 71
horizon: s
related: [3207, 2906, 3134, 1151, 2867]
umbrella: 2906
loc-budget-allow:
  - src/codegen/expressions.ts
---

# Native `$Promise` loses struct identity through a `$Promise`-returning call (double-wrap)

## Problem

Banked by #3207: in async-generator / async code, a native `$Promise` that
flows through a **user-function return** (`yield mk()` where
`mk(): Promise<number>`) or a **Promise-typed local** initialised by such a call
(`const pv = mk(); yield pv`) loses its native `$Promise` struct identity, so the
suspend's `ref.test $Promise` misses and the value is delivered raw → **NaN**,
while `yield await mk()` → 5 works.

Measured on the host-free wasi drive lane (`.tmp/probe-promise-identity.mts`),
before this fix:

```
yield await mk()                       → 5    (control, works)
yield mk()                             → NaN  (call-return operand)
const pv = mk(); yield pv              → NaN  (Promise-typed local)
yield Promise.resolve(5)               → 5    (control, direct expression)
const pv = Promise.resolve(5); yield pv → 5    (control, direct local)
```

The differentiator is the **user-function return**: the direct-expression /
direct-local controls preserve identity, so it is neither the local-store nor
the yield machinery — it is `mk()`'s call-site coercion.

## Root cause (why the identity drops)

`mk` (a plain, non-`async` function returning `Promise<number>`) already returns
a real native `$Promise` externref on the carrier lane — its body
`return Promise.resolve(5)` lowers to a `ref.test`-guarded PromiseResolve that
yields the `$Promise`. But at the **call site**:

1. `isAsyncCallExpression` (expressions.ts) classifies `mk()` as an "async call"
   via the `isPromiseType(callSig.getReturnType())` fallback (#1151) — it matches
   any signature returning `Promise<T>`, not only `async` declarations.
2. `yield mk()`'s consumer is a `thenable` (the `YieldExpression` parent), so
   `asyncResultConsumedAsValue` returns `false` → the wrap is NOT skipped.
   (`yield await mk()` has an `AwaitExpression` parent → `value` consumer → wrap
   IS skipped, which is why the control works.)
3. `calleeIsDriveLowered` returns `false` — it only recognises drive-lowered
   `async` *declarations*, and `mk` is a plain function.
4. `wrapAsyncReturn`'s standalone/carrier arm then **unconditionally** builds a
   SECOND `$Promise{FULFILLED, <mk()'s $Promise>, null}` — a Promise-of-Promise.

Downstream, the async-gen yield suspend arm's `ref.test $Promise` succeeds on the
OUTER wrapper (state FULFILLED), reads field 1 = the inner `$Promise`, and
delivers it as `SENT`. Reading `.value` off a `$Promise` object → NaN.

This violates PromiseResolve idempotence (§25.6.4.5.1 / §27.2.4.7:
`Promise.resolve(p)` returns `p` when `p` is already a Promise). The
drive-lowered-callee skip (`calleeIsDriveLowered`, #2867) already acknowledged
the double-wrap for one narrow callee class; the fix generalises the correctness
to a **runtime** guard covering every `$Promise`-returning callee.

## Fix

`wrapAsyncReturn`'s `isStandalonePromiseActive` arm (expressions.ts) is made
idempotent: a runtime `ref.test $Promise` guard passes an **already-`$Promise`**
value through UNCHANGED; a raw value takes the **unchanged** fulfilled-mint
(byte-identical to pre-#3220 in that arm). One function, ~13 added instructions,
mirroring `emitStandaloneAwaitUnwrap`'s proven guard shape.

This resolves BOTH banked shapes at once, because both route the identity drop
through `mk()`'s single `wrapAsyncReturn` call site:

```
yield mk()                → 5   (was NaN)
const pv = mk(); yield pv → 5   (was NaN)
```

## Scope / carrier gating

The arm is reached only when `isStandalonePromiseActive(ctx)` (wasi, or
non-wasi standalone when the promise carrier is on — i.e. `!widenAsyncGenFallback`).
So:

- **gc/host** — `isStandalonePromiseActive` is false → the arm is never reached →
  byte-identical for every program.
- **standalone async-gen modules** — `widenAsyncGenFallback` keeps the carrier
  off → byte-identical (host-consistent pipeline preserved, #2980).
- **unrelated (non-async) modules** — never call `wrapAsyncReturn` →
  byte-identical in every lane.
- Only a **`$Promise`-returning call consumed as a thenable** on the active
  carrier lane changes bytes, and only from the buggy double-wrap to the correct
  passthrough (or the identical fulfilled-mint for a genuinely-raw value).

## Byte-inertness proof (the −16/−29 discipline)

sha256 (first 16 hex) of representative programs × {gc, standalone, wasi},
origin/main base vs branch (`.tmp/hash-3220.mts`, base restored via
`git checkout origin/main -- src/codegen/expressions.ts`). 16/18 identical; the
ONLY two changes are the async-gen fix on wasi:

| program            | gc        | standalone                 | wasi                          |
| ------------------ | --------- | -------------------------- | ----------------------------- |
| nonAsync           | identical | identical                  | identical                     |
| **promiseCallYield** | identical | identical (widenAsyncGenFb) | **CHANGED** (intended unlock) |
| **promiseCallLocal** | identical | identical (widenAsyncGenFb) | **CHANGED** (intended unlock) |
| awaitCallYield     | identical | identical                  | identical                     |
| directPromiseYield | identical | identical                  | identical                     |
| plainGen           | identical | identical                  | identical                     |

For an async-generator module, the standalone lane keeps `widenAsyncGenFallback`
on (carrier off) so it is byte-identical (host-consistency preserved). A separate
**non-generator** module (`mk().then(v=>v+1)`, `.tmp/probe-standalone-nongen.mts`)
confirms the standalone carrier lane IS reached and changed by the fix, while gc
stays identical:

| lane       | base       | branch     |
| ---------- | ---------- | ---------- |
| gc         | `57aab3fa…` | `57aab3fa…` (identical) |
| standalone | `45b4b9f6…` | `b8101202…` (CHANGED)  |
| wasi       | `ad9f20df…` | `d1b5dc32…` (CHANGED)  |

## Verification

`tests/issue-3220-promise-return-double-wrap.test.ts` (6 host-free wasi tests,
all pass: the `yield mk()` fix → 5; the `const pv = mk(); yield pv` fix → 5; the
`yield await mk()` control parity; a genuinely-pending call whose promise settles
on a later microtask (suspends at kick, resumes to 42 on drain); a
mixed call-then-plain-yield sequence; and the direct-expression control).
`tsc --noEmit` clean.

## Test Results

- **Repro (host-free wasi, `.tmp/probe-promise-identity.mts`)** — before → after:
  `yield mk()` NaN → 5; `const pv = mk(); yield pv` NaN → 5; the three controls
  (`yield await mk()`, `yield Promise.resolve(5)`, direct local) stay 5.
- **test262 standalone A/B** (process-isolated `runTest262File`, 590 files:
  async-function / async-arrow / await / Promise resolve·reject·then·all·race·finally),
  branch vs base: `{pass:348, fail:226, compile_error:16}` on BOTH — **zero flips,
  zero regressions**. (These files don't isolate the double-wrap shape, so no
  fail→pass here; the genuine unlock is the wasi async-gen drive lane the harness
  can't target, proven non-vacuously by the vitest tests above.)
- **test262 gc A/B** (249 files: async-function / async-arrow / await), branch vs
  base: **zero flips** — confirms the hash-proven gc inertness behaviourally.
- **vitest async/async-gen/Promise blast radius** (17 files, 129 tests:
  async-await, async-census, 1042[-host-drive], 2895[-drain-hook],
  2906-3a/3b/3di/3dii/multiawait/gap3, 2865, 3134, 2623, 3207, 3220): 124 pass;
  the 5 failures (3× gap3-tryfinally throw-path, 2× issue-2865 AG0-wasi harness)
  are **pre-existing on origin/main** — verified an identical 5-fail set on the
  base checkout (`git checkout origin/main -- src/codegen/expressions.ts`). Zero
  regressions.
