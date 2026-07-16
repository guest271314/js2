---
id: 3300
title: "Porffor backend P5: prove shared allocation-policy leverage"
status: ready
sprint: porffor-backend
created: 2026-07-16
updated: 2026-07-16
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: performance
area: ir, codegen-linear, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: [3299]
related: [3288, 3298, 3299, 747]
origin: "#3288 P5 split: independently dispatchable allocation-policy comparison"
---

# #3300 - Porffor backend P5: prove shared allocation-policy leverage

## Objective

Demonstrate that `LinearMemoryPlan` is a meaningful shared optimization layer
by selecting and comparing at least two allocation policies without changing
the linear-Wasm or Porffor semantic emitters.

## Scope

Implement and compare:

1. the current bump/arena baseline; and
2. one non-trivial policy justified by existing analyses, preferably stack
   promotion for non-escaping fixed-size allocations with managed-heap fallback
   for escaping values.

Use a fixed benchmark set and report output size, peak memory, allocation
count, and runtime for both linear-Wasm and Porffor-C where supported.

## Acceptance criteria

- [ ] Both policies consume the same allocation sites, layouts, pointer maps,
      roots, barriers, and symbolic runtime ABI from `LinearMemoryPlan`.
- [ ] Switching policy requires no changes to `LinearEmitter` or
      `PorfforEmitter` semantic-operation implementations.
- [ ] The alternative policy preserves behavior under alias, identity, bounds,
      and collection-stress fixtures.
- [ ] A checked-in measurement note records code size, runtime, peak memory,
      allocation count, supported IR families, exact Porffor commit, compiler,
      and benchmark commands.
- [ ] Results distinguish planner decisions from backend-specific artifact
      effects and document any unsupported comparison explicitly.
- [ ] The issue changes are committed, pushed to `origin`, and published as a
      ready, non-draft PR before completion is reported.

## Validation

- Run the P4 heap differential and stress corpus under both policies.
- Run the fixed benchmark suite with warmup/repetition sufficient to report
  stable medians and peak-memory methodology.
- Run linear-Wasm emit-identity coverage for the baseline policy.
- Run scoped IR/equivalence and merge-group conformance validation.

## Non-goals

- Declaring one policy universally optimal from the pilot benchmark set.
- Coupling the shared planner to C, Porffor, or a particular allocator symbol.
- Expanding backend legality beyond families required by the proof.

## Completion of parent

After this PR merges, revalidate every acceptance criterion in #3288 and update
the parent with child PR links, measured results, supported families, and the
final completion status.
