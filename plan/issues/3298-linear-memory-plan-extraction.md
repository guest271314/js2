---
id: 3298
title: "Porffor backend P3: extract the shared target-neutral LinearMemoryPlan"
status: ready
sprint: porffor-backend
created: 2026-07-16
updated: 2026-07-16
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: architecture
area: ir, codegen-linear, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: [3297, 2956]
related: [3288, 2953, 2956, 3029, 747]
origin: "#3288 P3 split: independently dispatchable shared linear-memory planning layer"
---

# #3298 - Porffor backend P3: extract the shared target-neutral LinearMemoryPlan

## Objective

Make JS2's middle end the single owner of allocation class, layout, root, and
barrier decisions through a backend- and artifact-neutral `LinearMemoryPlan`
consumed by both linear-Wasm and the optional Porffor backend.

## Scope

1. Define plan and allocator-policy interfaces whose vocabulary remains useful
   without Porffor or C.
2. Feed the planner from allocation-site IDs and existing escape, ownership,
   encoding, and stack-allocation analyses under `src/ir/analysis/`.
3. Centralize size, alignment, field-offset, element-stride, pointer-map,
   lifetime, safepoint, barrier, data-segment, and global-storage decisions.
4. Keep allocator/runtime operations symbolic through planning.
5. Adapt linear-Wasm to consume the plan while preserving byte identity under
   the default arena policy for unchanged programs.

## Acceptance criteria

- [ ] `LinearMemoryPlan` contains no Wasm instructions/indices, Porffor enums or
      arrays, C fragments, renderer assumptions, or concrete runtime symbols.
- [ ] There is one canonical plan per allocation site/shape shared by initial
      linear-memory consumers.
- [ ] Linear-Wasm consumes the plan without changing default-policy behavior or
      established emitted bytes.
- [ ] Function registration order cannot change symbolic allocator/runtime
      references before module assembly.
- [ ] Removing the optional Porffor adapter requires no planner changes.
- [ ] The issue changes are committed, pushed to `origin`, and published as a
      ready, non-draft PR before completion is reported.

## Validation

- Run focused planner and layout tests.
- Run `prove-emit-identity` coverage for the default linear-Wasm policy.
- Run scoped linear-backend equivalence and regression tests.
- Run merge-group conformance validation because this slice changes shared
  production planning.

## Non-goals

- Choosing Porffor's value ABI, object layout, builtins, or GC.
- Implementing a second allocation policy; #3300 owns that proof.
- Making C the preferred or mandatory output.

## Handoff

After this PR merges, #3299 lowers representative heap layouts through
Porffor IR using this plan without re-planning them in the adapter.
