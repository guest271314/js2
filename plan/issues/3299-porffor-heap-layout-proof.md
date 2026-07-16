---
id: 3299
title: "Porffor backend P4: heap and layout proof through shared planning"
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
area: ir, codegen-linear, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: [3298]
related: [3288, 3297, 3298]
origin: "#3288 P4 split: independently dispatchable Porffor heap/layout proof"
---

# #3299 - Porffor backend P4: heap and layout proof through shared planning

## Objective

Prove that Porffor IR can execute JS2-planned heap layouts without adopting or
silently depending on Porffor's own object representation.

## Scope

1. Lower one fixed-shape object and one dense numeric vector/array family using
   `LinearMemoryPlan` and Porffor `Alloc`, `Load`, and `Store` operations.
2. Preserve JS identity, aliasing, mutation, bounds, and layout semantics.
3. Lower planned root and barrier operations. For arena-only policy, document
   and test why no barrier is required; for managed policy, emit `GcBarrier`
   and stress collection safety.
4. Differentially execute the same typed SSA IR through linear-Wasm and
   Porffor-C.

## Acceptance criteria

- [ ] Two aliases observe the same mutation while two equal-looking allocated
      objects remain non-identical.
- [ ] Fixed-shape field offsets and vector strides come exclusively from the
      shared plan.
- [ ] Vector bounds and mutation behavior match JavaScript and linear-Wasm.
- [ ] Root/barrier behavior follows the selected planned runtime policy and is
      covered by stress validation where collection is possible.
- [ ] The Porffor adapter does not reinterpret values as Porffor-native objects
      or call builtins that assume Porffor layouts.
- [ ] The issue changes are committed, pushed to `origin`, and published as a
      ready, non-draft PR before completion is reported.

## Validation

- Run heap alias, identity, mutation, and bounds tests.
- Run three-way differential fixtures for the supported heap families.
- Run managed-allocation stress tests when the selected policy can collect.
- Run linear-Wasm emit-identity coverage for unaffected programs.

## Non-goals

- General JS object coverage.
- Adopting Porffor NaN boxing, builtins, object layouts, or GC wholesale.
- A second allocation strategy.

## Handoff

After this PR merges, #3300 must demonstrate that allocation policy can change
without changing either backend's semantic emitter.
