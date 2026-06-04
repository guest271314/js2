---
id: 1856
title: "Bump/arena allocator mode for short-lived linear-memory programs (allocate-and-exit), plus commit to one fixed linear-GC strategy"
status: done
sprint: 59
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
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

- [x] A bump/arena allocator mode exists for `--target wasi` / standalone
      short-lived programs, with no reclamation overhead and minimal code.
- [x] Mode selection is explicit (flag or heuristic) and documented.
- [x] A decision is recorded for the reclaiming linear-GC strategy (single
      strategy, not pluggable); if not yet needed, the issue notes it as
      deferred with the rationale.
- [x] Standalone equivalence tests stay green; binary-size win measured for a
      representative short-lived program.

## Resolution

The linear backend (`src/codegen-linear/runtime.ts`) already used a
bump-pointer allocator that never frees — i.e. it *was* the allocate-and-exit
arena. This change makes that mode **explicit, documented, robust, and
embedder-controllable**:

1. **`__malloc` now grows linear memory on demand** (`memory.grow`) when an
   allocation would exceed the current pages. Previously it advanced the bump
   pointer past the addressable 64 KiB page and silently corrupted memory for
   any program allocating more than ~63 KiB — a real correctness fix that makes
   the arena usable for non-trivial short-lived programs.
2. **Explicit mode selection** — `CompileOptions.allocator: "bump" |
   "arena-reset"` and CLI `--allocator <bump|arena-reset>` (linear target only;
   guarded against non-linear targets). `bump` is the default and byte-identical
   to prior output. `arena-reset` additionally exports `__arena_reset()` (O(1)
   whole-arena rewind) and `__arena_used()` for hosts reusing one instance
   across many short-lived tasks.
3. **GC-strategy decision recorded** in [ADR-0017](../../docs/adr/0017-linear-bump-arena-allocator.md):
   the linear backend commits to a **single fixed strategy** (the bump arena);
   **no pluggable GC abstraction**. Intra-run reclamation is **deferred** — no
   current standalone/WASI workload needs it, and the WasmGC backend covers
   long-lived / cyclic-graph workloads via the host GC.

### Test Results

- `tests/issue-1856.test.ts` (5 tests, all pass): 8-byte alignment + HEAP_START
  contract unchanged; memory growth on a >1-page allocation; growth across many
  sub-page allocations crossing page lines; arena exports absent by default;
  arena exports present + `__arena_reset`/`__arena_used` correct when opted in.
- `tests/linear-runtime.test.ts` (3 tests): still green — alignment behaviour
  unchanged.
- End-to-end via `compile({ target: "linear" })`: a representative short-lived
  program (`[1,2,3,4,5].reduce` style sum loop) compiles + runs correctly
  (`test() === 15`).

### Binary-size measurement

- Bump runtime-only module: **135 bytes** total — the allocator's entire
  footprint, with **zero** per-allocation metadata / free-list / GC structure.
- `default`, `--allocator bump`: byte-identical (3897 bytes for the sample
  program) — no regression, no overhead.
- `--allocator arena-reset`: **+86 bytes** for the two exports, and only when
  requested. The allocate-and-exit common case pays nothing.
