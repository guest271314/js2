---
id: 2865
title: "Standalone: no Wasm-native async-generator / for-await carrier — leaks __create_async_generator + Promise_* host imports"
status: ready
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
