---
id: 3299
title: "Porffor backend P4: heap and layout proof through shared planning"
status: done
sprint: porffor-backend
created: 2026-07-16
updated: 2026-07-17
completed: 2026-07-17
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
claimed_by: porffor-codex-developer
claimed_at: 2026-07-17T16:08:01.435Z
branch: symphony/porffor/3299
pr: 3263
loc-budget-allow:
  - src/ir/builder.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
last_ci_retry_head: bf951fe7ddbd208830096214c84584130ae8acce
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

- [x] Two aliases observe the same mutation while two equal-looking allocated
      objects remain non-identical.
- [x] Fixed-shape field offsets and vector strides come exclusively from the
      shared plan.
- [x] Vector bounds and mutation behavior match JavaScript and linear-Wasm.
- [x] Root/barrier behavior follows the selected planned runtime policy and is
      covered by stress validation where collection is possible.
- [x] The Porffor adapter does not reinterpret values as Porffor-native objects
      or call builtins that assume Porffor layouts.
- [x] The issue changes are committed, pushed to `origin`, and published as a
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

## Implementation record (2026-07-17)

- Extended shared backend handles with each allocation site's canonical
  `LinearAllocationSitePlan`. The Porffor resolver now requires a completed
  `LinearMemoryPlan`, verifies each site/layout pairing, and exposes record
  fields and vector layout operations without re-planning them.
- Added symbolic Porffor heap expressions/statements and final assembly for the
  pinned `Alloc`, `Load`, and `Store` nodes. Fixed-shape fields use only planned
  field offsets; vectors use only planned length/capacity/elements offsets,
  minimum capacity, allocation size, and element stride. Allocations use type
  id zero and never invoke Porffor object/array builtins, `jsval`, NaN boxing,
  native layouts, or parser/codegen paths.
- Added the typed `vec.set` terminal operation across the backend contract,
  verifier/effects/ownership passes, WasmGC emitter, linear emitter, and
  Porffor emitter. Bounds remain explicit in surrounding typed SSA; the
  terminal performs one planned in-bounds store.
- Selected the existing `arena-v1` plan policy. Every supported site is
  non-moving arena allocation with `root:none`, `safepoints:none`, and
  `barrier:none`; the adapter rejects managed sites, non-arena policies, or a
  renderer with `prefs.gc` enabled. Therefore no `GcBarrier` is emitted and a
  managed-collection stress run is inapplicable for this slice.
- The focused fixture executes one identical typed SSA module through
  linear-Wasm and rendered Porffor-C, with a JavaScript oracle. Results
  `[911, 309, 300, 300]` prove alias-visible mutation, identity/non-identity,
  vector mutation, and negative/high out-of-bounds reads.

Validation completed:

- `IR_VERIFY_ALLOC=1 pnpm exec vitest run tests/issue-3299.test.ts tests/issue-3298.test.ts tests/issue-3297.test.ts tests/issue-3288.test.ts tests/backend-contract.test.ts tests/ir-vec-two-backend.test.ts tests/ir/alloc-registry.test.ts tests/ir/alloc-provenance.test.ts --reporter=dot`
  (8 files, 56 tests passed)
- `pnpm exec vitest run tests/issue-3297.test.ts tests/issue-3298.test.ts tests/issue-3299.test.ts`
  (3 files, 11 tests passed, including Porffor-C rendering compiled with
  warnings as errors)
- `npx --yes tsx scripts/prove-emit-identity.mjs check --baseline .tmp/emit-identity-3299.json`
  (all 56 file/target outcomes identical to the clean pre-change
  `origin/main` baseline)
- `pnpm run build`
- `pnpm run typecheck`
- focused `biome lint` over changed IR/backend/tests
- `pnpm run check:pushraw` (79 call sites, one fewer than merge-base)
- `pnpm run check:linear-ir`
- `pnpm run check:ir-fallbacks`
