---
id: 3924
title: "linear backend: the bump arena is never reclaimed across calls — 4 benchmarks trap with memory access out of bounds; all 4 pass with allocator: arena-reset"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen-linear
language_feature: memory-management
goal: performance
sprint: current
horizon: m
es_edition: n/a
related: [3908, 3935, 3904]
---

# #3924 — linear bump arena is never reclaimed between invocations

## Status: open — root cause established by controlled experiment

## Problem

Four benchmarks' linear lanes trap with `memory access out of bounds` partway
through a run. The cause is not a lowering bug: **the bump arena is never
reclaimed, and the harness invokes `run()` repeatedly.** Each call allocates
into a monotonically advancing arena until memory is exhausted.

The experiment that establishes this — recompiled with
`allocator: "arena-reset"` and rewinding between calls, **all four pass with
correct values**:

| benchmark | trapped at | result with arena-reset |
| --- | --- | --- |
| `string/split` | call 4 / 55 | `80000` ✓ |
| `mixed/csv-parse` | call 6 / 25 | `30000` ✓ |
| `mixed/sieve` | call 7 / 25 | `9592` ✓ |
| `array/map-filter` | call 28 / 55 | `3334` ✓ |

The spread in trap points (4 to 28) is consistent with per-call allocation
volume, which is what you would expect from an unreclaimed arena.

**`string/concat-short` is NOT this bug** — it still traps at call 0 even with
reset, because it allocates ~1.5 GB of quadratic intermediates *within* a single
call. That is #3935.

## The decision to make

Two defensible fixes, and they are not equivalent:

1. **Harness-side** — compile the linear lane with `allocator: "arena-reset"`
   and rewind between `run()` calls. Small, contained, and arguably correct
   since each benchmark invocation is meant to be independent. But it makes the
   benchmark lane behave unlike a real embedding.
2. **Backend-side** — give the lane an automatic reclaim policy. Larger, but it
   addresses the real question: what *should* a long-running linear-memory
   module do when its arena fills? Any real WASI program has this problem, not
   just our harness.

Option 1 unblocks four bars quickly; option 2 is the honest fix. They can be
sequenced — do 1 to restore measurement, then 2 — but if you do only 1, say so
explicitly in the issue so the underlying gap is not mistaken for closed.

## Scope

1. Confirm the reproduction independently.
2. Choose and implement, recording which of the two you did and why.
3. If harness-side: make sure the published page does not present an
   arena-reset lane as if it were the default allocation behaviour.

## Acceptance criteria

1. All four benchmarks produce correct linear-lane results across a full run.
2. The choice between harness-side and backend-side is recorded with reasoning.
3. If only the harness-side fix lands, the backend gap stays open and is
   linked.

## Provenance

`issue-3908-linear-validation`'s 26-lane inventory. It ran each lane for
`warmup + iterations` calls rather than once, specifically because a 1-shot
call under-reports — several lanes only trap after the arena fills. That
methodology choice is what made this diagnosable.
