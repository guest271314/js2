---
id: 3295
title: "Porffor backend P0: freeze the optional IR compatibility surface"
status: done
assignee: ttraenkler/codex-senior-3295
sprint: porffor-backend
pr: 3109
completed: 2026-07-16
created: 2026-07-16
updated: 2026-07-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
model: gpt-5.6-sol
task_type: infrastructure
area: ir, backend, tooling
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: []
related: [3288, 2953, 2956, 3030]
origin: "#3288 P0 split: independently dispatchable Porffor compatibility boundary"
---

# #3295 - Porffor backend P0: freeze the optional IR compatibility surface

## Objective

Define and test the smallest JS2-owned compatibility surface required to emit
Porffor IR at the optional submodule commit pinned in `vendor/Porffor`.

This slice establishes an explicit version boundary before production lowering
depends on Porffor's experimental internal enums or module-record shape.

## Scope

1. Record the supported Porffor node, type, effect, function-record, and
   module-record shapes against the pinned commit.
2. Add a schema fingerprint test covering enum names/order and renderer input
   fields. A changed pin must fail with an actionable compatibility diagnostic.
3. Define the optional loader boundary. Core code uses JS2-owned structural
   types; Porffor modules are loaded dynamically only by the adapter tool and
   optional integration tests.
4. Keep normal install, typecheck, build, and tests functional when
   `vendor/Porffor` is absent or uninitialized.

## Acceptance criteria

- [x] JS2-owned types describe only the Porffor structures required by the
      pilot and contain no static production import from `vendor/Porffor`.
- [x] A compatibility test validates the pinned node/type/effect enums and the
      renderer's function/module input records before rendering.
- [x] A mismatched pin fails before emission with the expected and observed
      schema fingerprints.
- [x] Core typecheck and non-Porffor tests pass with the submodule unavailable.
- [x] The issue changes are committed, pushed to `origin`, and published as a
      ready, non-draft PR before completion is reported.

## Implementation record (2026-07-16)

P0 landed in PR #3107, with the independently dispatchable issue boundary and
renamed focused test finalized in PR #3109. Both PRs are merged; #3288 remains
the tracking umbrella and #3296 owns the next implementation slice.

### Files

- `src/ir/backend/porffor/compat.ts` freezes the exact commit, all 56 `K`
  names/ordinals, eight `T` entries, six `FX` entries, six node slots, and the
  JS2-owned function/module renderer records. A real `Const` probe verifies the
  six-slot `[kind, type, effects, a, b, c]` constructor shape.
- `src/ir/backend/porffor/loader.ts` checks the Git pin before dynamically
  importing `compiler/ir.js` and `compiler/render.js`. It validates renderer
  input before invocation and wraps import, schema, and render drift in an
  actionable compatibility diagnostic. It is not on the public export graph.
- `tests/issue-3295-porffor-compat.test.ts` covers compatible and mismatched
  enums, mismatched commits, malformed nodes/records, unavailable checkout,
  and optional real-renderer invocation.

### Pinned findings

At `60a1d41d60580ff4faa38ffd5f7783d23df68bad`, Porffor's required renderer
record is `{ funcs, data, globals, entry, prefs, usedTypes }`. Each live
function requires `{ name, index, params, retType, locals, body }`; parameters
and globals use `{ name, type }`; function indices equal their `funcs` slots.
The optional integration test passes that exact shape and receives C containing
the probe function.

### Validation

- `pnpm run typecheck` - pass with `vendor/Porffor` absent.
- `pnpm run build` - pass with `vendor/Porffor` absent; 297 modules transformed.
- `pnpm run lint` and focused Prettier/Biome checks - pass.
- `pnpm exec vitest run tests/issue-3295-porffor-compat.test.ts` - 7 passed,
  1 optional integration test skipped.
- `JS2WASM_PORFFOR_ROOT=<pinned-read-only-checkout> pnpm exec vitest run tests/issue-3295-porffor-compat.test.ts`
  - 8 passed, including real renderer invocation.

### Boundaries and handoff

This slice adds no backend kind, generic lowering change, Porffor sink,
`LinearMemoryPlan`, C compilation, or runtime differential test. Those remain
owned by dependency-ordered children. After #3295 merges, #3296 is next and is
gated by both #3295 and #2953.

## Validation

- Run the focused compatibility and optional-loader tests.
- Run core typecheck with the Porffor integration disabled.
- Exercise the mismatch diagnostic with a controlled fixture rather than
  modifying the checked-out submodule.

## Non-goals

- Emitting a JS2 function as Porffor IR.
- Importing Porffor's parser, AST lowering, builtins, object layouts, or GC.
- Adding a public `compile()` target.

## Handoff

After this PR merges, #3296 may rely on the JS2-owned structural contract and
optional loader without importing Porffor internals into generic lowering.
