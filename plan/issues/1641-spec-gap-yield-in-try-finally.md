---
id: 1641
title: "spec gap: yield in nested try/finally + yield expression evaluation order (46 test262 fails)"
status: blocked
created: 2026-05-08
updated: 2026-05-27
blocked_by: [680]
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
sprint: 50
renumbered_from: 1347
parent: 1328
---
# #1347 — yield expression: try/finally + evaluation order

## Problem

`language/expressions/yield`: **16 / 63 pass (25.4%) — 46 fails (31 assertion_fail, 13 other,
2 type_error)**.

Spec §15.5.5 (YieldExpression) requires:
1. **Single-step evaluation**: the expression is evaluated, the value is sent to the consumer,
   then the consumer's return value (if .next(value) is called with a value) becomes the result
   of the yield expression.
2. **try/finally interaction**: when a generator is suspended at a yield, calling `.return()` triggers
   the finally block to run before the generator completes.
3. **yield* delegation**: forwards the iterator protocol to the inner iterable, including
   .return/.throw forwarding.
4. **yield in argument list**: `f(yield 1, yield 2)` evaluates yield 1 first, then yield 2.
5. **yield in compound expression**: `[yield 1, 2]` — yield 1 first, then 2.

The 31 assertion_fail failures suggest:
- yield* doesn't forward `.return()` correctly through nested delegation.
- Try/finally finalizers aren't run on early `.return()`.
- yield evaluation order in complex expressions isn't observed correctly.

## Acceptance criteria

1. `language/expressions/yield/star-iterable.js` passes.
2. `language/expressions/yield/star-rhs-iter-rtrn-meth-throws.js` passes.
3. `language/expressions/yield/yield-as-yield-operand-in-fn-arg.js` passes.
4. Pass-rate for `language/expressions/yield` rises from 25% to ≥70%.

## Files to modify

- `src/codegen/expressions.ts` — yield expression compiler
- `src/codegen/statements.ts` — try/finally lowering interaction with yield
- `src/codegen/registry/iterator.ts` — yield* delegation

## Implementation Plan

### Root cause

The yield state machine collapses each yield to a single suspension point with a specific
state-tag, but try/finally introduces an extra "abrupt-completion handler" state that we
don't materialize. When `.return()` is called on a generator suspended inside a try block,
we should jump to the finally block before completing, but we instead complete directly.

For yield*: the delegation loop reads from `.next()` of the inner iterable but doesn't forward
the outer's `.return(value)` and `.throw(error)` to the inner — it just propagates upward.

### Approach

1. **try/finally + yield**: extend the generator state struct with a "pending-return-value" slot.
   When `.return()` is called while suspended in a try, set the slot, jump to finally block, then
   on finally exit either rethrow or return.
2. **yield* delegation**: the inner-iterator must be stored in a generator-local field. On
   `.return()`/`.throw()` from outside, dispatch to the inner-iterator's matching method (if any).
3. **Evaluation order**: the parser/IR-lowerer should preserve sequential yield-evaluation by
   binding intermediate values to temporaries before the next yield.

### Edge cases

- yield* on null/undefined → TypeError ("not iterable").
- yield in finally block of an outer try — the finally should run to completion before re-throwing.
- yield* on an iterator that doesn't define `.return` or `.throw` — silently ignore the inner
  call (don't crash).

### Test262 sample

- `test262/test/language/expressions/yield/star-rhs-iter-rtrn-meth-throws.js`
- `test262/test/language/expressions/yield/star-iterable.js`
- `test262/test/language/expressions/yield/yield-as-yield-operand-in-fn-arg.js`

## Investigation 2026-05-27 (developer) — ESCALATED-NEEDS-SPEC, blocked on #680

Reproduced against current main (HEAD 92c7483a4) with a standalone instantiate
harness (compile + runtime `buildImports` + `setExports`). Findings:

| Probe | Got | Expected | Verdict |
|-------|-----|----------|---------|
| basic `yield* inner()` then `yield 3`, collect via for-of | `"123"` | `"123"` | OK |
| `try { yield 1; yield 2 } finally { log+="F" }`, `.next()` then `.return(99)` | `""` | `"F"` | **finally never runs** |
| `yield* inner()` where inner has try/finally; `.next()` then `.return(0)` | `""` | `"innerF"` | **no return-forwarding** |
| `.return(99)` return value | `{value:99,done:true}` | same | OK (shape only) |
| `try { yield 1 } finally { log+="F" }`, drive to completion with `.next()`×2 | `""` | `"F"` | **finally never runs even on NORMAL completion** |
| `try { yield 1 } catch { log+="C" } finally{...}`, `.throw(err)` | error escapes | caught → `"CF"` | **try/catch around yield is inert** |

### Root cause (architectural, not a localized bug)

Generators are compiled with an **eager-yield buffer** model, not a suspendable
state machine:

- `compileYieldExpression` (`src/codegen/expressions/misc.ts:162`) pushes each
  yielded value into a JS array (`__gen_push_f64/_i32/_ref`) and **always
  returns `ref.null.extern`** — `yield` can never receive a `.next(v)` value.
- `yield*` (`misc.ts:177`) calls `__gen_yield_star`, which **eagerly drains the
  whole inner iterable** into the buffer (`src/runtime.ts:5673`).
- The generator body runs **to completion before `.next()` is ever called**
  (eager-buffer, hard cap `__EAGER_GEN_LIMIT = 1_000_000`, `runtime.ts:5650`).
  `.return()`/`.throw()` therefore have no suspended frame to resume into, so
  `finally`/`catch` blocks around a yield are never interleaved with consumer
  control — they run (if at all) only during the eager pre-pass, decoupled from
  `.return()`/`.throw()`.

Every #1641 acceptance criterion (finally-on-`.return()`, `yield*`
`.return`/`.throw` forwarding, single-step `.next(v)` value reception,
evaluation order across suspension) is **structurally impossible** under the
eager-buffer model. They are exactly the Phase-3 deliverables of **#680
(Wasm-native generators / state machines)** — see #680 lines 35-39 (limitations)
and 184-193 (Phase 3: yield*, throw, return + finally cleanup path).

### Recommendation

Not a developer-scope `fix(...)`. **Block #1641 on #680** (the suspendable
state-machine rewrite) and fold its acceptance tests into #680 Phase 3, or
attach #1641 to the native-generator design effort tracked by task #93
(`#1665 native generators — shared $Iterator design gap`). No localized patch to
`misc.ts` / `statements.ts` / `iterator.ts` can satisfy the criteria without
that rewrite. Status set to `blocked` (blocked_by: 680).
