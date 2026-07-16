---
id: 3297
title: "Porffor backend P2: scalar and control-flow differential proof"
status: ready
sprint: porffor-backend
created: 2026-07-16
updated: 2026-07-16
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: feature
area: ir, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: [3296]
related: [3288, 3295, 3296, 3030]
origin: "#3288 P2 split: independently dispatchable scalar Porffor backend proof"
---

# #3297 - Porffor backend P2: scalar and control-flow differential proof

## Objective

Lower a real scalar/control-flow subset of JS2 typed SSA IR into Porffor IR,
render it through the pinned optional renderer, compile the C, and prove
behavior against JavaScript and JS2's linear-Wasm backend.

## Scope

1. Implement `PorfforSink` as a structured builder with a statement list and
   expression/value stack while preserving left-to-right evaluation and
   effects.
2. Implement constants, numeric conversion/arithmetic/comparison, locals,
   globals, select, structured conditionals/blocks/loops/branches, direct
   calls, return, and unreachable.
3. Reject every heap/reference operation in this slice.
4. Assemble functions and modules with stable symbolic names; assign Porffor
   array positions only during final assembly.
5. Render with the pinned Porffor renderer, compile with the available CI C
   compiler, and execute differential fixtures.

## Acceptance criteria

- [ ] Real JS2 IR reaches Porffor IR through the five-part backend contract;
      there is no parallel AST-to-Porffor front end.
- [ ] Expression construction preserves operand order and `FX` semantics for
      effectful scalar/control-flow fixtures.
- [ ] Unsupported heap/reference IR fails through legality before emission.
- [ ] Scalar fixtures produce equal results under JavaScript, linear-Wasm, and
      Porffor-C.
- [ ] Function and module assembly is deterministic and independent of
      registration order.
- [ ] The issue changes are committed, pushed to `origin`, and published as a
      ready, non-draft PR before completion is reported.

## Validation

- Run focused IR-node mapping and operand-order tests.
- Run three-way scalar differential tests.
- Compile rendered C with warnings treated as errors where supported.
- Run existing backend contract tests.

## Non-goals

- Heap allocation, objects, arrays, roots, or barriers.
- A public Porffor compile target.
- Adopting Porffor's `jsval` or object ABI.

## Handoff

After this PR merges and #2956 is complete, #3298 extracts the shared
backend-neutral linear-memory plan.
