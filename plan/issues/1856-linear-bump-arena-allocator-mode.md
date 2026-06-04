---
id: 1856
title: "Bump/arena allocator mode for short-lived linear-memory programs (allocate-and-exit), plus commit to one fixed linear-GC strategy"
status: ready
sprint: 59
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: performance
area: codegen
language_feature: compiler-internals
goal: standalone-mode
related: [1662]
---
# #1856 — Bump/arena allocator mode for short-lived linear programs

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R10** (P2).

## Problem

On the **linear-memory backend** (`src/codegen-linear/`) we own allocation.
The field consensus on memory management for AOT-to-Wasm is twofold:

1. **Don't build a pluggable/interchangeable GC.** Supporting tracing and
   reference-counting as swappable strategies is documented as *not viable*
   (RC can't collect cycles, so you bolt on tracing anyway). Pick one fixed
   strategy.
2. **A bump/arena "allocate-and-never-free" mode is a near-free win for
   short-lived programs.** Most conformance / CLI-style WASI programs
   allocate and exit; for them, a tracing collector is pure overhead and
   code size. (On the **WasmGC backend** this whole problem is delegated to
   the host GC — see the doc's R10 / the codegen-axes backend split.)

## Recommendation

- Add a **bump/arena allocator mode** for the linear backend, selected for
  short-lived/standalone programs (allocate from a growing region, free
  nothing, rely on process exit to reclaim). Smallest-binary, fastest path.
- For programs that genuinely need reclamation, commit to **one** fixed
  strategy (tracing, or RC-with-a-cycle-collector) — **not** a pluggable
  abstraction.

## Acceptance criteria

- [ ] A bump/arena allocator mode exists for `--target wasi` / standalone
      short-lived programs, with no reclamation overhead and minimal code.
- [ ] Mode selection is explicit (flag or heuristic) and documented.
- [ ] A decision is recorded for the reclaiming linear-GC strategy (single
      strategy, not pluggable); if not yet needed, the issue notes it as
      deferred with the rationale.
- [ ] Standalone equivalence tests stay green; binary-size win measured for a
      representative short-lived program.
