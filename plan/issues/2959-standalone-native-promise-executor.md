---
id: 2959
title: "Standalone: native `new Promise(executor)` — retire the unconditional Promise_new host import"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: promises
goal: standalone-mode
related: [2867, 1326, 2895]
origin: "2026-07-02 July Fable audit §2/§4 (largest single promise gap; #2867 Phase-1E open item promoted to its own dispatchable slice)"
---

# #2959 — the executor pattern always leaks a host import

## Problem

`new Promise((resolve, reject) => …)` unconditionally lowers to the
`Promise_new` host import — there is no native branch
(`src/codegen/expressions/new-super.ts:2773-2792`, verified 2026-07-02).
Everything downstream of the executor pattern (a huge share of test262
async tests and real-world code) is therefore host-bound even though the
whole rest of the carrier ($Promise struct, `__promise_resolve_value`
recursive assimilation, `__promise_reject`, microtask ring, native
`.then/.catch`, `Promise.all/race`) is already native. The audit ranks this
the highest-leverage single promise slice.

## Approach

Add an `isStandalonePromiseActive(ctx)` branch at the new-super.ts lowering
site:

1. Allocate a pending `$Promise`.
2. Synthesize the `resolve` / `reject` closures over the existing
   `__promise_resolve_value` / `__promise_reject` helpers (resolve must go
   through the assimilation path so a promise-resolved-with-a-promise
   chains, and both must be no-ops after the first settle — the
   already-settled guard exists in the helpers; verify).
3. Invoke the executor synchronously (spec: it runs before `new Promise`
   returns); an executor throw before settle ⇒ reject with the exception
   (route via the throw→reject wiring from #2867 Gap 2).
4. Return the `$Promise`.

Closure plumbing is the risk: the two settle closures capture the promise
— use the standard ref-cell capture machinery, no bespoke path.

## Acceptance criteria

- Executor programs (resolve-sync, resolve-async-via-then, reject, throw,
  double-settle-ignored, resolve-with-thenable) behave to spec on
  `--target wasi`, zero `env::` imports in the emitted binary.
- Gate scope matches the carrier gate (wasi now; widens with #2867
  slice 1d — do not pre-widen, the −601 lesson).
- Host mode byte-unchanged; host-free floor strictly up (this flips a
  large pass-but-leaky cohort).
