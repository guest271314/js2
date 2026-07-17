---
id: 3142
title: "IR module-level (top-level statement) adoption — clears gate G3 of the legacy-frontend retirement"
status: in-progress
assignee: ttraenkler/fable-alpha
sprint: current
created: 2026-07-11
updated: 2026-07-16
note: "Slice 1 (selector + telemetry) landing via PR; Slice 2 (lowering + __module_init patch) remains — issue stays in-progress until Slice 2."
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
# Slice 1 adds the module-init claim assessment to the selector; it must live
# in select.ts because it reads the module-level isPhase1* walk state
# (earlyReturnLoopDepth / barrier / forInitLeakedNames) that is deliberately
# not exported (see the threading rationale on currentHostGlobalResolver).
loc-budget-allow:
  - src/ir/select.ts
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

## Slice plan (fable-alpha, 2026-07-16)

Precedent: #1370 Phase A landed the class-member claim unit **selector-only**
first, then wired integration in Phase B. Same sequencing here:

- **Slice 1 (this PR) — selector assessment + `module-level` telemetry bucket.**
  - `src/ir/select.ts`: new `IrModuleInitAssessment` on `IrSelection`
    (`moduleInit?`), populated under `trackFallbacks` only (production
    compiles byte-identical — `STRICT_IR_REASONS` is empty, so
    `trackFallbacks` is off outside the gate/tests). The assessment takes the
    top-level statement population (everything except function/class/type/
    import/export declarations), wraps it in a synthetic void
    `<module-init>` FunctionDeclaration, and runs the EXISTING per-kind
    rules: `isPhase1BodyStatement` per statement (constructor-body
    precedent: no tail requirement, early-return barrier armed), then the
    same external-call / call-graph-closure gate as Step 2 via
    `buildLocalCallGraph` over `declByName ∪ {<module-init>}` — every local
    callee must be in the FINAL claimed set. Rejection reasons reuse
    `IrFallbackReason` per the architect plan.
  - `scripts/check-ir-fallbacks.ts`: new `moduleLevel` baseline section
    (rejection-reason histogram over corpus modules) gated
    must-not-increase, plus informational claimable/empty counts;
    back-compat with baselines lacking the field (info-only until
    refreshed).
  - `scripts/ir-fallback-baseline.json`: corpus baseline for the new bucket.
  - `tests/issue-3142.test.ts`: unit tests over `planIrCompilation`
    (empty population, claimable init, body-shape reject, external-call,
    call-graph-closure).
- **Slice 2 (follow-up) — lowering + integration.** Build the synthetic
  module-init through from-ast/lower with a module-scope outermost LowerCtx
  (bindings → symbolic `global.get/set`, reusing the existing global/export
  machinery in `declarations.ts`), patch the `__module_init` slot in
  `compileIrPathFunctions`, and demote whole-module to legacy on any
  build/verify failure (the existing warning channel). Flip the selector
  assessment from telemetry-only to claim-feeding.
