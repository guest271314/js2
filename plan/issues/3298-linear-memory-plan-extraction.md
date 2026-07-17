---
id: 3298
title: "Porffor backend P3: extract the shared target-neutral LinearMemoryPlan"
status: in-progress
sprint: porffor-backend
created: 2026-07-16
updated: 2026-07-17
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
claimed_by: porffor-codex-developer
claimed_at: 2026-07-17T13:18:45.605Z
branch: symphony/porffor/3298
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

- [x] `LinearMemoryPlan` contains no Wasm instructions/indices, Porffor enums or
      arrays, C fragments, renderer assumptions, or concrete runtime symbols.
- [x] There is one canonical plan per allocation site/shape shared by initial
      linear-memory consumers.
- [x] Linear-Wasm consumes the plan without changing default-policy behavior or
      established emitted bytes.
- [x] Function registration order cannot change symbolic allocator/runtime
      references before module assembly.
- [x] Removing the optional Porffor adapter requires no planner changes.
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

## Implementation record (2026-07-17)

- Added the immutable, serializable `LinearMemoryPlan` and allocator-policy
  seam under `src/ir/analysis/`. The plan owns record/vector/string/opaque
  layouts, per-site size and allocation class, pointer maps, lifetime, roots,
  safepoints, barriers, relocatable data, symbolic global storage, and semantic
  runtime operations without importing either backend.
- The planner runs the existing encoding, ownership, escape, and stack-candidate
  analyses over a module-global `AllocSiteRegistry`. Allocation provenance was
  completed for `box` and `vec.new_fixed`, so every currently modeled heap
  producer can contribute a durable per-site decision.
- Linear IR compilation now builds all claimed functions first, creates one
  module plan, binds allocation-site handles to its canonical layouts and
  operations, and only then lowers. Aggregate helper bodies are materialized
  after user-function registration, so their allocator binding cannot leak a
  stale function index into the plan.
- The direct linear class-layout API delegates to the same record-layout
  primitive. `LinearEmitter` reads vector offsets, stride, minimum capacity,
  record fields, and symbolic allocation operations from plan-backed handles;
  the default arena adapter retains the prior runtime calls and byte stream.
- The optional Porffor adapter is not imported by the planner. #3299 can consume
  the exported plan and its symbolic operations directly when heap legality is
  added, without duplicating layout or policy decisions.

Validation completed:

- `npx vitest run tests/issue-3298.test.ts` (4 tests passed)
- `IR_VERIFY_ALLOC=1 npx vitest run tests/issue-3298.test.ts tests/issue-2956.test.ts tests/ir/alloc-registry.test.ts tests/ir/alloc-provenance.test.ts tests/issue-3297.test.ts tests/issue-3288.test.ts tests/backend-contract.test.ts tests/issue-2952.test.ts tests/issue-1982-ir-emission-order.test.ts --reporter=dot`
  (9 files, 74 tests passed)
- `npx tsx scripts/prove-emit-identity.mjs check --baseline .tmp/emit-identity-3298.json`
  (all 56 file/target outcomes identical to the pre-change baseline)
- `npm run build`
- `npm run typecheck -- --pretty false`
- `npm run lint`
- `npm run format:check`
- `npm run check:pushraw`
- `npm run check:loc-budget`
- `npm run check:ir-fallbacks`
- `npm run check:linear-ir`
