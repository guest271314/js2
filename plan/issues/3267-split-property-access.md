---
id: 3267
title: "Split property-access.ts — extract builtin static/prototype VALUE-read subsystem into builtin-value-read.ts"
status: ready
sprint: current
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/senior-dev-split
---

## Scope

Behaviour-preserving god-file split of `src/codegen/property-access.ts` (8872 LOC).
Extract the cohesive **built-in static/prototype VALUE-read** subsystem into a new
sibling module `src/codegen/builtin-value-read.ts`:

- Metadata tables: `BUILTIN_CTOR_NAMES`, `WELL_KNOWN_SYMBOLS`, `MATH_CONSTANT_PROPS`,
  `NUMBER_CONSTANT_PROPS`, `MATH_CONSTANT_VALUES`, `NUMBER_CONSTANT_VALUES`,
  `TYPED_ARRAY_BYTES_PER_ELEMENT`, `BUILTIN_CTOR_ARITY`.
- Value-read machinery (#1907 / #1888 S6-b): `getWellKnownSymbolId`,
  `tryEmitBuiltinNamespaceConstantValue`, `typedArrayViewSignedness`,
  `hasNativeBuiltinConstantHandler`, `emitArrayIsArrayExternrefPredicate`,
  `reportUnsupportedStandaloneBuiltinValueRead`, `makeBuiltinClosureFctx`,
  `tryEnsureNativeProtoBrand`, `tryCompileStandaloneBuiltinProtoMemberMeta`,
  `tryCompileStandaloneBuiltinProtoMemberRead`,
  `ensureStandaloneBuiltinStaticMethodClosure`.

This is a PURE MOVE (verbatim cut-paste, no logic changes). The group has zero real
code back-edges into `property-access.ts`; the new module imports only leaf helpers
and nothing loops back. `property-access.ts` re-exports the symbols external modules
import (`calls.ts`, `builtin-static-gopd.ts`) and imports back the ones it still calls
internally. Mirrors the #808 import-infra extraction.

## Acceptance

- `npx tsc --noEmit` → 0 errors.
- `npx tsx scripts/prove-emit-identity.mjs check` → **IDENTICAL** (39/39 emits across
  gc/standalone/wasi). This is the behaviour gate — a pure move must not change emit.
- Relocation-shift ratchets (loc-budget / oracle-ratchet / coercion-sites) satisfied via
  per-issue frontmatter allowances (below), justified by byte-identity IDENTICAL.

## Relocation-shift allowances

Populated after running the ratchets locally (per-issue preauth; byte-identity IDENTICAL
proves total usage is conserved — these are relocation false-positives, not new debt).
