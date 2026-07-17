---
id: 2570
title: "lazy/suspending async-generator runtime — yield* execution order (eager-buffer drains before first .next())"
status: in-progress
assignee: fable-2570
sprint: Backlog
created: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: async-generators
goal: core-semantics
depends_on: [1373b]
related: [1887, 2566, 2170, 2171, 1927]
test262_bucket: async-gen-yieldstar-execution-order
test262_count: 86
---

## Context

Spun out of #1887. The FILED #1887 symptom (325 invalid-Wasm `array.set` CEs in
async `yield*` closures) was **already fixed** on main by #2170/#2171
(native-generator + result-struct work) — that bucket re-buckets to 0. Closing
#1887 as symptom-done.

The **residual ~86 fails** (down from 325) are a **different, architectural
problem**: async generator **execution order / laziness**.

## Problem

js2wasm's generator runtime is an **eager buffer**: `src/runtime.ts:135`
`buf: any[] — eager-yield buffer (filled by the generator body)`. The generator
body runs **up front** and drains the inner iterator into a buffer **before** the
consumer's first `.next()`. So an async `yield*` over a source with observable
side effects violates the spec's lazy, one-step-per-`.next()` semantics:

```js
async function* inner() { log.push("a"); yield 1; log.push("b"); yield 2; }
async function* outer() { yield* inner(); }
const it = outer();
assert(log.length === 0);   // FAILS — eager buffer already ran inner() to completion
await it.next();            // should produce "a" then 1, lazily
```

The execution-order test262 files assert `log.length === 0` (or step-by-step
ordering) immediately after construction and before the first `.next()`; the
eager buffer fails them at construction time.

## Root cause is shared with #2566

The **same eager-buffer runtime** is the root cause of **#2566** (sync
capturing-generator over-consumption — a trailing array-destructuring elision
over a generator drains it to completion). #2570 (async) and #2566 (sync) are
**two faces of one architectural gap**: the generator runtime is eager, not
lazy/suspending.

## Fix direction (architectural — multi-PR)

Replace the eager-buffer model with a **lazy / suspending generator runtime** — a
CPS state machine that suspends at each `yield`/`yield*` and resumes on `.next()`,
so the body runs incrementally and side effects interleave per spec. This is the
async-generator analogue of the await-CPS lowering tracked in **#1373b** (IR
async CPS), and overlaps the front-end pipeline work (#1927).

**Recommend a unified architect spec** covering the lazy/suspending generator
runtime for BOTH sync (#2566) and async (#2570) generators, sequenced behind /
alongside #1373b's CPS substrate — rather than two independent point attempts on
a shared substrate.

## Acceptance

- Async `yield*` execution-order test262 cluster (~86) passes: side effects of the
  delegated iterator interleave lazily, one step per `.next()`, nothing runs
  before the first `.next()`.
- No regression to the now-passing async-generator invalid-wasm bucket (#2170/#2171).
- Coordinated with #2566 (sync) so the lazy runtime serves both.
