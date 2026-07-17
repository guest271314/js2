---
id: 3336
title: "planning: make LinearMemoryPlan ownership target-neutral before dispatch"
status: ready
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: easy
reasoning_effort: medium
task_type: planning
area: planning, ir, codegen-linear, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
sprint: Backlog
horizon: s
es_edition: n/a
related: [2956, 3288, 3298, 3299, 3300]
origin: "2026-07-17 current-origin/main PO audit: target-neutral linear-memory work is still scheduled inside the Porffor backend wave"
---

# #3336 - Planning: make LinearMemoryPlan ownership target-neutral before dispatch

## Problem

The current plan says the `LinearMemoryPlan` must be backend- and artifact-neutral,
but the canonical dispatch metadata still routes the shared planner through the
Porffor backend wave. That mismatch is small in prose and large in practice:
self-serving agents pull by `sprint`, title, parent, and dependency-graph shape.
A target-neutral allocator/planner task can therefore be claimed as a Porffor/C
deliverable even though linear-Wasm and future native consumers must remain first
class.

## Evidence on current `origin/main`

- `plan/issues/3288-porffor-ir-backend.md:3-14` names the parent "Optional
  Porffor IR backend" and assigns `sprint: porffor-backend`, while
  `plan/issues/3288-porffor-ir-backend.md:32-36` says Porffor is only a proof
  consumer, not owner of the plan.
- The same parent explicitly says "`LinearMemoryPlan` is part of JS2's
  target-neutral middle end" and that C must not become mandatory at
  `plan/issues/3288-porffor-ir-backend.md:83-94`.
- The shared planner slice is still titled "Porffor backend P3" and scheduled
  as `sprint: porffor-backend` at
  `plan/issues/3298-linear-memory-plan-extraction.md:3-20`, even though its
  objective is a backend- and artifact-neutral plan consumed by linear-Wasm and
  Porffor at `plan/issues/3298-linear-memory-plan-extraction.md:25-41`.
- The allocation-policy proof is also scheduled as `sprint: porffor-backend`
  at `plan/issues/3300-linear-memory-allocation-policy-proof.md:3-20`, and its
  benchmark scope compares "linear-Wasm and Porffor-C where supported" at
  `plan/issues/3300-linear-memory-allocation-policy-proof.md:40-41`.
- A current text search for `LinearMemoryPlan`, `target-neutral`, and
  `porffor-backend` finds the ownership invariant only inside the Porffor issue
  family. No issue owns correcting the planning taxonomy before #3298/#3300 are
  dispatched.

## Impact

This is a planning/architecture risk, not a code defect. If #3298 or #3300 is
implemented under Porffor ownership, the team can accidentally freeze a planner
vocabulary, test proof, or allocator policy around one optional adapter. That
would undermine #2956's linear-IR path, the production linear-Wasm backend, and
future direct C/LLVM/MLIR/native consumers.

## Root cause / unknowns

The Porffor split correctly included target-neutral non-goals, but the issue
family inherited Porffor titles, parentage, sprint labels, and proof framing.
The open decision is whether to retitle/reparent the shared planner slices or to
create a separate backend-neutral parent and make Porffor a downstream consumer.

## Proposed approach

1. Decide and document the ownership taxonomy for `LinearMemoryPlan`:
   shared middle-end parent vs. retitled standalone shared-planner slices.
2. Update canonical issue metadata and titles so target-neutral work is not
   dispatched as "Porffor backend P3/P5" unless the title also makes the shared
   ownership explicit.
3. Update `plan/log/dependency-graph.md` and the backlog/sprint notes so
   linear-Wasm is listed as a first-class consumer and Porffor is listed as one
   optional proof adapter.
4. Tighten #3298/#3300 acceptance criteria so a Porffor-C result alone cannot
   satisfy shared-planner completion. Linear-Wasm consumption, byte-identity or
   semantic equivalence, and future-consumer neutrality must remain explicit.

## Non-goals

- Implementing `LinearMemoryPlan`, allocator policies, Porffor lowering, or
  linear-Wasm code changes.
- Choosing C, LLVM, MLIR, or Porffor as a preferred output.
- Blocking the in-progress #2956 implementation work; this is a planning fix
  that should work around active PRs rather than rewrite their code.

## Dependencies / related issues

- Related: #3288 parent Porffor proof, #3298 shared planner extraction,
  #3300 allocation-policy proof, #3299 Porffor heap-layout consumer proof.
- Related active work: #2956 linear backend consumes IR. Do not narrow this
  issue to Porffor or C.
- No code dependency blocks this planning update.

## Why this is not already covered

#3288/#3298/#3300 contain the right target-neutral warnings in prose, but none
of them owns changing the canonical planning metadata that agents use to pull
work. This issue is specifically about correcting the dispatch surface before
shared linear-memory planning is claimed.

## Acceptance criteria

- [ ] The active `LinearMemoryPlan` planning surface no longer presents the
      shared planner as only a Porffor backend phase. Either #3298/#3300 are
      retitled/reframed, or a backend-neutral parent/sibling issue is introduced
      and the Porffor issues are made explicit consumers.
- [ ] `plan/log/dependency-graph.md` lists the shared planner in a
      backend-neutral section and identifies linear-Wasm as a first-class
      consumer.
- [ ] #3298/#3300 acceptance criteria require evidence that shared planner
      decisions remain meaningful without Porffor or C and remain consumable by
      the production linear-Wasm path.
- [ ] The update touches planning files only and does not change compiler code.
- [ ] `pnpm run check:issues`, `pnpm run check:issue-ids`, and
      `GATE_BASE=origin/main pnpm run check:issue-ids:against-main` pass.

## Validation plan

- Re-run `rg -n "LinearMemoryPlan|target-neutral|porffor-backend|Porffor-C" plan/issues plan/log`
  and verify the shared planner has an explicit backend-neutral dispatch path.
- Run the issue integrity and issue-ID gates listed in the acceptance criteria.
- Review current open PRs before editing #3288/#3298/#3300 so the planning
  update does not overwrite active implementation notes.
