---
id: 3267
title: "Split property-access.ts — extract builtin static/prototype VALUE-read subsystem into builtin-value-read.ts"
status: done
completed: 2026-07-14
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

## Result

- `src/codegen/property-access.ts`: 8937 → 7990 LOC.
- `src/codegen/builtin-value-read.ts`: new module, 1058 LOC (19 symbols moved verbatim).
- `npx tsc --noEmit` → **0 errors**.
- `npx tsx scripts/prove-emit-identity.mjs check` → **IDENTICAL** (39/39 file,target emits
  across gc/standalone/wasi).
- `tests/issue-3267.test.ts` → 7 standalone smoke tests passing (each routes through a
  distinct cut in the extracted module).

Wiring: `property-access.ts` imports back the 12 symbols it still calls internally and
re-exports the 9 that `calls.ts` / `builtin-static-gopd.ts` import from it (their
`from "./property-access.js"` imports resolve unchanged). The new module imports only
leaf helpers — zero back-edge into `property-access.ts`, no import cycle.

## Relocation-shift ratchets

Byte-identity IDENTICAL proves total usage is conserved, so relocation-shift flags are
false-positives (usage moved module home, not grew).

- **loc-budget** — OK, no allowance needed (net +111 LOC, new module under the god-file
  threshold).
- **oracle-ratchet** — 2 relocated checker sites (`getTypeAtLocation` + `ctx.checker`) in
  `typedArrayViewSignedness` moved into `builtin-value-read.ts`. Added a `preauthorized`
  entry per site in `scripts/oracle-ratchet-baseline.json` (the gate's only documented
  remedy; additive append, mirrors the #808 god-file-split precedent already there).
  `property-access.ts`'s count decreased by the same 1 each.
- **coercion-sites** — OK, no allowance needed.
- **dead-exports (audit-legacy-reachability)** — OK, 0 new.
- **verdict-oracle-bump** — OK, no verdict-logic files changed.
