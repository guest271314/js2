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
architect_spec: candidate
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

A **genuinely-pending** await — a promise that only settles on a *later*
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
