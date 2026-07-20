---
id: 3268
title: "Break up god-file src/codegen/declarations.ts (extractions + DRY dedup)"
status: done
completed: 2026-07-14
sprint: 72
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/senior-dev-declfile
# Relocation-shift ratchet allowances (#3131) — verbatim god-file split, total
# checker/coercion usage CONSERVED (declarations.ts loses exactly what the new
# sibling modules gain). Change-scoped per-issue hatch; NOT a whole-tree baseline edit.
# NOTE: the frontmatter list parser (scripts/lib/change-scope.mjs) breaks on the
# first non-`- item` line, so list items MUST be contiguous — no interleaved comments.
loc-budget-allow:
  - src/codegen/declarations/import-collector.ts
coercion-sites-allow:
  - src/codegen/declarations/import-collector.ts
# oracle-ratchet-allow lists: (1) this change-set's own new modules
# (verbatim-relocated checker sites); (2) inherited main baseline-lag from
# concurrent god-file splits merged into this branch (#3264 array-prototype-borrow
# and a calls.ts drift) — the oracle baseline is not auto-refreshed for increases,
# so a downstream PR that merges main after those lands re-flags files it never
# touched (same remedy #3267 applied for array-prototype-borrow.ts; a no-op when
# already within baseline).
oracle-ratchet-allow:
  - src/codegen/declarations/import-collector.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/declarations/struct-type-registration.ts
  - src/codegen/array-prototype-borrow.ts
  - src/codegen/expressions/calls.ts
---

# Break up god-file `src/codegen/declarations.ts`

## Problem

`src/codegen/declarations.ts` is a ~5,683-LOC god file. It mixes several
cohesive subsystems (single-pass import/feature collector, #1121 param/return
numeric-type inference, empty/growable object-shape pre-pass, interface/object
struct-type registration) plus copy-pasted signature/param-lowering blocks.

## Scope

Behaviour-preserving refactor — emitted Wasm MUST stay byte-for-byte identical
(`scripts/prove-emit-identity.mjs check` = IDENTICAL across gc/standalone/wasi),
`tsc --noEmit` stays at 0.

### Extractions (verbatim moves into sibling modules)

- `src/codegen/declarations/import-collector.ts` — the `UnifiedCollectorState`
  subsystem (state shape + factory + `unifiedVisitNode` + `finalizeUnifiedCollector`
  - `isAccessorDescriptor` + `CONSOLE_METHODS_SET` / `HOST_PROMISE_SOURCE_METHOD_NAMES`).
- `src/codegen/declarations/param-return-inference.ts` — #1121 cluster
  (`resolveGenericCallSiteTypes`, `inferParamTypeFromCallSites`,
  `inferParamTypeFromBody`, `inferNumericReturnTypes`).
- `src/codegen/declarations/object-shape-widening.ts` — empty/growable/array
  shape pre-pass (`collectEmptyObjectWidening`, `collectGrowableObjectLiterals`,
  `collectPropsFromStatements`, `applyShapeInference`, and the pure helpers).
- `src/codegen/declarations/struct-type-registration.ts` — `collectInterface`,
  `resolveStructFieldTypes`, `collectObjectType` (optional; paired with dedup D4).

### Dedups (shared helpers)

- D1 `computeFunctionSignature` — the duplicated signature computation between
  `registerBodylessFunctionDeclaration` and `collectDeclarations`.
- D2 `lowerParamType` — the 4x per-parameter lowering block.
- D3 delete the two byte-identical local closures shadowing
  `bindingPatternParamNeedsWiden` / `restBindingOverridesToExternref`.
- D4 `registerStructType` — the 3x struct-type registration idiom (in registry/types.ts).
- D5 `recordDefinePropertyWiden` — the 2x descriptor value-type extraction.

## Acceptance

- `scripts/prove-emit-identity.mjs check` prints IDENTICAL (39/39 file,target).
- `tsc --noEmit` reports 0 errors.
- All relocation-shift ratchets green (per-issue frontmatter allowances if tripped).
- `tests/issue-3268.test.ts` smoke test compiles programs exercising the touched paths.

## Result

- **declarations.ts: 5,683 → 2,408 LOC** (trunk). Four new sibling modules under
  `src/codegen/declarations/`: import-collector (1,949), object-shape-widening (732),
  param-return-inference (558), struct-type-registration (109).
- **Byte-identity: IDENTICAL (39/39)** vs current `origin/main`, verified by comparing
  a fresh origin/main emit against HEAD emit (0 diffs across gc/standalone/wasi).
- **Dedups applied (5):** D2 `lowerParamType` (4→1), D3 delete two shadowing
  binding-pattern closures, D4 `registerStructType` in registry/types.ts (3→1),
  D5 `recordDefinePropertyWiden` (2→1). **D1 (`computeFunctionSignature`) deferred** —
  the two signature copies wrap the shared computation in materially different
  func-creation/export bookkeeping (exported-flag + preRegisteredBodyless vs
  export/default + recordExportSignature), so merging risks type-index reordering;
  left as a follow-up.
- **WAVE-B intra-function target:** `unifiedVisitNode` in import-collector.ts is a
  ~1,086-LOC node-kind switch — the reason import-collector.ts crosses the 1,500 LOC
  budget (allowance granted). It is the next decomposition candidate now that it lives
  in its own module.

## Suspended / follow-ups

- D1 `computeFunctionSignature` dedup (deferred, see above).
- WAVE-B: decompose `unifiedVisitNode` (node-kind switch) into per-kind collectors.
  </content>
