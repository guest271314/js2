---
id: 3267
title: "Split property-access.ts — extract builtin static/prototype VALUE-read subsystem into builtin-value-read.ts"
status: done
completed: 2026-07-14
sprint: 72
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/senior-dev-split
oracle-ratchet-allow:
  - src/codegen/array-prototype-borrow.ts
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

## Salvage re-merge note (2026-07-14)

This PR went DIRTY as main advanced; re-merged `origin/main` on a salvage branch.
Two of main's advances interacted with this PR:

1. **#3266** (operator-assignment split) added its own `preauthorized` entries to
   `scripts/oracle-ratchet-baseline.json`. The merge conflict there was resolved as an
   **append-only union** — both #3267's `builtin-value-read.ts` entries and #3266's
   `operator-assignment.ts` entries are kept.
2. **#3264 / PR #3064** (array-methods → `array-prototype-borrow.ts` split) landed on main
   using a **self-only `oracle-ratchet-allow:` frontmatter allowance in its own issue
   file**, and did NOT bank `array-prototype-borrow.ts` into the committed whole-tree
   baseline (`scripts/oracle-ratchet-baseline.json`). `check:oracle-ratchet` is a
   **whole-tree** gate that only consults allowances from issue files **in the current
   change-set's diff** — #3264's issue file is on main (not in my diff), so the gate
   re-flags `array-prototype-borrow.ts` (4/4 checker sites vs baseline 0) against this
   PR's post-merge tree. It is #3264 merge-collateral, not growth introduced here.
   Remedy applied: the change-scoped `oracle-ratchet-allow: array-prototype-borrow.ts`
   frontmatter above (the gate's documented, conflict-free hatch; task-directed over a
   whole-tree baseline bump). Byte-identity IDENTICAL (39/39) is unaffected — this PR
   still emits zero net checker growth. **Systemic note for the tech lead:** every
   downstream PR that merges main after #3064 hits the same `array-prototype-borrow.ts`
   flag until main banks it into the committed oracle-ratchet baseline; a one-line
   post-merge baseline reconciliation on main would clear it queue-wide.
