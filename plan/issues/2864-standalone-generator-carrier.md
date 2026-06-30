---
id: 2864
title: "Standalone: no Wasm-native generator carrier — sync generators leak __create_generator/__gen_* host imports"
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
related: [2860, 680, 2865]
umbrella: 2860
architect_spec: candidate
---

# Standalone: Wasm-native generator carrier (sync)

## Problem

Sync generators (`function*`, generator methods, `yield`/`yield*`) work in
js-host via host imports but have **no general standalone carrier**. Only
"sequential numeric yields" are lowered natively (#680); anything else leaks
`__create_generator` / `__gen_create_buffer` / `__gen_next` / `__gen_yield_star`
/ `__gen_result_value` / `__gen_set_return` / `__gen_push_ref` / `__gen_push_f64`,
which under standalone either fail instantiation or hit the #680 refusal
(`src/codegen/function-body.ts:1020`).

### Impact (measured 2026-06-30) — ~697 standalone-only failures

Leaked imports across the gap: `__gen_create_buffer` 1,648, `__gen_next` 1,070,
`__create_generator` 748, `__gen_yield_star` 505 (these counts include the async
cases tracked in #2865). Manifests as `fail` (598) and CE (99); many proximate
errors are `illegal cast [in __obj_find() ← __extern_set]` inside the
destructuring/iterator machinery that the generator drives.

## Root cause

There is no Wasm-native coroutine/state-machine lowering for general generator
bodies in standalone. The host carrier buffers yields in a JS-side structure
(`__gen_*`). A standalone generator needs either:
1. a **resumable state-machine transform** (CPS / explicit state var + switch on
   re-entry, locals spilled to a heap frame struct), or
2. WasmGC **stack-switching** (the `stack-switching` proposal) if the target
   runtime enables it — but CLAUDE.md notes wasmtime rejects all-proposals; this
   is not portable yet.

Approach (1) is the portable path: lower a generator body to a `$GenFrame`
struct (captured locals + an i32 `state`), and a `next(frame, sentValue)`
function that `br_table`s on `state` to the resume point, runs to the next
`yield`, stores the next state, and returns `{value, done}`. `yield*` delegates
to the inner iterator's `next`.

## Implementation Plan

**Architecture-scale — tagged `architect_spec: candidate`.** Design needed
before coding. Key decisions for the architect:
- Frame representation: `struct $GenFrame (field $state (mut i32)) (field $localN (mut T))…`
  one field per live-across-yield local; reuse the ref-cell pattern for captures.
- State-machine transform location: in IR lowering (`src/ir/lower.ts`) vs the
  legacy codegen generator path (`src/codegen/function-body.ts`,
  `class-bodies.ts`, `closures.ts`). Prefer IR if generator nodes are adopted;
  else extend the #680 native path in function-body.ts:1020.
- `IteratorResult` representation: reuse the existing `{value, done}` $Object or
  a nominal struct; must satisfy the for-of / spread / destructuring consumers
  natively (overlaps #2863 `__array_from_iter_n` spread).
- `return()`/`throw()` completion (try/finally inside generators) → finally
  blocks must run on early completion; the state machine must encode finally
  regions.

Start scope: plain `function*` with value yields + `yield*` over an array /
another native generator. Defer `[Symbol.iterator]`-driven `yield*` over an
arbitrary host iterator until the iterator-protocol carrier is native.

## Test plan

Standalone fail/CE → pass:
- `test/language/expressions/yield/**`, `test/language/statements/generators/**`
- `test/built-ins/GeneratorFunction/**`, `test/built-ins/GeneratorPrototype/**`
- `test/built-ins/Iterator/prototype/{map,take,drop,flatMap}/**` (driven by gens)

Full `merge_group` + standalone high-water. This is the single largest lever
(sync 697 + async 986 = 1,683 combined with #2865). Sequence #2864 before #2865
(async generators build on this).
