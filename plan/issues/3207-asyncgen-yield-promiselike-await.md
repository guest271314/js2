---
id: 3207
title: "Standalone async-gen: implicit yield-await (§27.6.3.8) for PromiseLike-typed operands"
status: done
assignee: ttraenkler/opus-asyncgen
created: 2026-07-13
completed: 2026-07-13
priority: medium
feasibility: medium
task_type: feature
area: codegen
goal: standalone
sprint: 71
horizon: s
related: [3120, 2906, 2865]
umbrella: 2906
loc-budget-allow:
  - src/codegen/async-cps.ts
---

# Async-generator implicit yield-await (§27.6.3.8) for PromiseLike operands

## Problem

§27.6.3.8 `AsyncGeneratorYield(value)` runs `value = ? Await(value)` — a plain
`yield <E>` in an async generator implicitly **awaits any thenable** before
yielding it, not only the `Promise` builtin. #3120 landed the static classifier
(`yieldOperandIsPromiseTyped`) that routes a `Promise`-typed (or
union-with-Promise) plain `yield E` through the SAME suspend+`settleYield(fromSent)`
lane as `yield await E`. But it recognised **only** the `Promise` builtin (via the
receiver heuristic) + unions containing it.

A **`PromiseLike<T>`-typed operand** — a structural thenable — was classified
PLAIN, so the un-awaited thenable was yielded verbatim and the consumer saw the
promise OBJECT rather than the resolved value.

Measured on the host-free wasi drive lane (`.tmp/probe-reconcile.mts`), before this
fix:

```
yield t   // t: PromiseLike<number> = Promise.resolve(5)   → value NaN (promise object yielded)
yield await t                                              → value 5   (explicit await works)
```

## Fix

Extend `yieldOperandIsPromiseTyped` (async-cps.ts) to also classify a
`PromiseLike<T>`-typed operand as implicit-yield-await (one line +
`oracle.declaredNameOf(operand) === "PromiseLike"`). After the fix, `yield t`
delivers `5`, matching `yield await t`.

**Correct-or-inert (the #2367 graveyard rule).** When the PromiseLike operand is
backed by a native `$Promise` at runtime, the suspend arm's `ref.test $Promise`
succeeds and adopts it (delivering the resolved value). A NON-native thenable
fails that `ref.test` and falls through to the plain delivery — the **exact pre-fix
raw-yield behaviour** — so no shape regresses.

## Scope / carrier gating

The implicit-yield-await classifier is invoked **only** on the native-`$Promise`
carrier lane (`isStandalonePromiseActive`, wasi-only for async-gen modules — the
`widenAsyncGenFallback` keeps standalone async-gen on the host lane). So gc + host
+ standalone stay byte-identical; only the wasi native drive lane changes, and only
for a PromiseLike-typed yield operand.

## Byte-inertness proof (the −16/−29 discipline)

sha256 of 6 programs × {gc, standalone, wasi}, WITH vs WITHOUT the one-line fix
(`.tmp/hash-lanes.mts`, self-restoring A/B). **Exactly one** hash changed:

| program            | gc        | standalone | wasi                       |
| ------------------ | --------- | ---------- | -------------------------- |
| plainGen           | identical | identical  | identical                  |
| awaitYield         | identical | identical  | identical                  |
| promiseYield       | identical | identical  | identical                  |
| **promiseLikeYield** | identical | identical  | **CHANGED** (intended unlock) |
| plainAsync         | identical | identical  | identical                  |
| plainSync          | identical | identical  | identical                  |

Every gc + standalone lane is byte-identical; every wasi lane EXCEPT a
PromiseLike-typed async-gen yield is byte-identical.

## Verification

`tests/issue-3207-asyncgen-yield-promiselike.test.ts` (4 host-free wasi tests: the
settled-PromiseLike proof → 5; the genuinely-pending PromiseLike drain proof
(suspends at kick, resumes to 42); a mixed PromiseLike-then-plain sequence; and a
plain-yield parity guard). The async-gen blast radius (2906-3a/3b/3d-i/3d-ii/
multiawait, 3120, async-await, async-census, generators, 1042, 2895) shows the
SAME pre-existing failure set as `origin/main` (verified on the base checkout: the
3× gap3-tryfinally throw-path, 2× issue-2865 AG0-wasi harness, and 6× issue-1672
AsyncFromSyncIterator failures are all pre-existing, byte-identical to base since
those programs are not PromiseLike-yields). `tsc --noEmit` clean.

## Banked follow-up intel (higher-value, blocked BELOW the async-frame lane)

The dominant residual §27.6.3.8 gap is NOT a classifier issue: a native `$Promise`
that flows through a **user-function return** (`yield mk()` where
`mk(): Promise<number>`) or a **Promise-typed local** (`const pv = mk(); yield pv`)
loses its native `$Promise` struct identity — the suspend's `ref.test $Promise`
fails → the value is delivered raw → NaN. Measured: `yield await mk()` → 5 but
`yield mk()` (classified Promise) → NaN, and `const pv = mk(); yield pv` → NaN.
This is a **value-representation bug below the async-frame lane** (the same native
`$Promise` identity-preservation family, cf. `#3134` promise-value-slot-rep), not
an async-gen-machine problem — extending the yield-await classifier cannot reach
it. Also banked: `any`-typed runtime thenables need a runtime thenable probe in
the settle arm (the #3120 follow-up), not a static classification.
