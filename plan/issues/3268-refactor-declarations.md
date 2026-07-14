---
id: 3268
title: "Break up god-file src/codegen/declarations.ts (extractions + DRY dedup)"
status: in-progress
sprint: current
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/senior-dev-declfile
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
  + `isAccessorDescriptor` + `CONSOLE_METHODS_SET` / `HOST_PROMISE_SOURCE_METHOD_NAMES`).
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
</content>
