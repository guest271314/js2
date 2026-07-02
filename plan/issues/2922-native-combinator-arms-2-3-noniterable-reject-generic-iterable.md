---
id: 2922
title: "Standalone async widen: native Promise.all/race arms 2 & 3 — not-iterable→reject + generic iterable (residual receiver-cast layer after #2919 arm 1)"
status: ready
created: 2026-07-02
priority: medium
feasibility: hard
task_type: feature
area: codegen
goal: standalone
horizon: l
related: [2919, 2867, 2918, 2895, 2860]
umbrella: 2860
depends_on: [2919]
---

# Native Promise.all/race arms 2 & 3 (follow-up to #2919 arm 1)

## Context

#2919 landed **arm 1** — native host-free `Promise.all`/`race` over an
array-TYPED non-literal argument (`Promise.all(arrVar)`), clearing the
array-value receiver-cast traps under the wasi async carrier. Two argument arms
remain on the host path (which is suppressed host-free under wasi → leaves
`ref.null.extern` → the trailing `.then`'s `ref.cast $Promise` traps with
"illegal cast"):

## Arm 2 — not-iterable → reject TypeError

`Promise.all(1)` / `(null)` / `(true)` / `(symbol)` … must settle a **rejected**
`$Promise` carrying a native `TypeError`. GetIterator-throws (arm 3) routes here
too. **Check what native error / `Test262Error` construction already exists
under the carrier before re-deriving** (spec note from #2919).

## Arm 3 — generic iterable

`Promise.all(set)` / a custom `[Symbol.iterator]`: host-free `GetIterator(arg)` +
`.next()` loop feeding the shared `__combinator_subscribe`. **Reuse the
standalone for-of iterator lowering — do NOT fork it.** A GetIterator-based path
subsumes arms 1+2+3, but arm 1's direct `array.len`/`array.get` (already landed)
is simpler + highest-coverage, so arm 3 layers on top for the non-array shapes.

## Discipline (non-negotiable — the async-graveyard rule)

Carrier-gated (`isStandalonePromiseActive`, wasi-only — do **not** widen the gate
here), byte-inert on gc/host + standalone (sha256-prove), corpus-verified against
the async leaky-pass corpus and the −16/−29 guard. Watch late-import funcIdx
shifts (`shiftAsyncSideChannelFuncIdxs` / `COMBINATOR_FUNC_IDX_KEYS`). Escalate
if a deeper value-representation change is needed (the Gap-4 output-vec contract).

## Entry points (from #2919 arm 1)

- Gate: `src/codegen/expressions/calls.ts` `isAggregator` block, after the arm-1
  `resolveExternrefVecArg` check falls through.
- Substrate: `src/codegen/promise-combinators.ts` (`__combinator_subscribe`,
  `emitStandalonePromiseCombinatorRuntime`, `ensureCombinatorFunctions`).
- Tests: extend `tests/issue-2867-gap4.test.ts` (add `#2922 arm 2/3` cases).
