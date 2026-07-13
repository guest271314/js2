---
id: 3142
title: "IR module-level (top-level statement) adoption — clears gate G3 of the legacy-frontend retirement"
status: ready
sprint: Backlog
created: 2026-07-11
updated: 2026-07-11
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
related: [3090, 2855, 2856]
origin: "plan/bloat-reduction-battle-plan.md slice 6; gate G3 in plan/log/3090-phase0-legacy-delete-list.md"
---

# #3142 — IR adoption for module-level statements (gate G3)

## Problem

The IR claim unit is the `FunctionDeclaration` (+ class members). **Top-level
statements are never claimable**, so `compileStatement` and every legacy statement
handler stay reachable for module-level code even when all function bodies are
IR-owned — gate **G3** in `plan/log/3090-phase0-legacy-delete-list.md`. No legacy
statement handler can be deleted until the IR can own module-level lowering.

## Implementation Plan (architect)

1. **New claim unit**: a synthetic module-init function wrapping the top-level
   statement list, selected by `src/ir/select.ts` under the same per-kind rules as
   function bodies (rejection buckets reuse `IrFallbackReason`; falls back whole-module
   to legacy, exactly like the function-level demote channel).
2. **LowerCtx scope**: module scope = outermost LowerCtx; exported bindings map to
   the existing global/export machinery in `src/codegen/declarations.ts` (shared,
   "stays" bucket) — reuse, don't fork.
3. **Ratchet**: add a `module-level` telemetry bucket to `check:ir-fallbacks` so
   adoption is measurable on the corpus like every other bucket.
4. Sequencing: independent of the IR-first default flip (#3143); both must land
   before #3090 Phase 3 handler deletions.

## Acceptance criteria

- Modules whose top-level statements are all IR-supported kinds compile their
  module-init through the IR (verifiable via `trackFallbacks`).
- ir-fallback gate has a `module-level` bucket with a corpus baseline.
- Equivalence suite + merge_group net ≥ 0.
