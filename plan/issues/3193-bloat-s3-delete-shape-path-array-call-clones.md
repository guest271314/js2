---
id: 3193
title: "bloat S3: delete the 5 shape-path Array.prototype.*.call clones, route through the synthetic-call rewrite"
status: done
assignee: dev-3193
completed: 2026-07-17
created: 2026-07-12
updated: 2026-07-19
priority: medium
feasibility: medium
task_type: refactor
area: codegen
es_edition: n/a
language_feature: array-methods
goal: maintainability
sprint: 72
horizon: m
umbrella: 3182
related: [3029, 3102, 3185]
---

# #3193 — bloat S3: delete the 5 shape-path Array.prototype.*.call clones

Slice **S3** of the #3182 code-bloat-elimination epic. See #3182 §D3.

## Problem

`compileArrayPrototypeCall` (`src/codegen/array-methods.ts:2290`) has TWO
lanes for the same methods:

- **shape-inferred lane** → dedicated near-clones of the direct-method impls:
  `compileArrayPrototypeIndexOf` (`:2378`), `...Includes` (`:2501`),
  `...Every` (`:2585`), `...Some` (`:2727`), `...ForEach` (`:2849`) — ~700 LOC
  duplicating `compileArrayIndexOf` (`:4462`), `compileArrayEvery` (`:8219`),
  `compileArraySome` (`:8154`), `compileArrayForEach` (`:7715`) incl. a second
  copy of the closure-invocation loop scaffolding.
- **TS-type lane** → a **synthetic-call rewrite** (`:2356-2371`) routing to
  `compileArrayMethodCall` (`:3246`) that reuses everything.

The clones exist only because `compileArrayMethodCall`'s receiver resolution
(`resolveArrayInfoForExpression` `:652`) never consults `ctx.shapeMap`.

## Approach (verified anchors)

- Make receiver resolution shapeMap-aware — extend
  `resolveArrayInfoForExpression` (`:652`) to consult `ctx.shapeMap` for
  identifier receivers, mirroring the lookup at `:2323`. Then the
  shape-inferred lane takes the same synthetic-call rewrite (`:2356-2371`) and
  the five clones die.
- **Edge cases to diff BEFORE deleting** (clone vs direct impl):
  callback-must-be-inline-arrow gate (`:2603`) vs the direct lane's
  `setupArrayCallback`, receiver null-guard, `undefined`-capable results. If a
  clone encodes a semantic the direct lane lacks, port the semantic FIRST
  (separate commit) so the deletion commit stays zero-diff.

## Acceptance criteria

- Zero test-diff; `compileArrayPrototype{IndexOf,Includes,Every,Some,ForEach}`
  deleted; ~700 LOC net negative in array-methods.ts.
- `pnpm run typecheck` clean.

## Coordination (priority lowered: hot-file collision)

`src/codegen/array-methods.ts` is under active behavioral change
(dev-array-hof, #3185 slices #3199-#3201, epic S6 #3196). Priority is
**medium** so it does not churn against conformance work. Claim
**serially** with #3196 (disjoint ranges: S3 is `:2378-3075`, S6 is
`:763-1887`, but both shift line numbers — re-anchor by symbol). Re-merge
`origin/main` immediately before enqueue.

## Resolution (2026-07-17)

The code had moved from `array-methods.ts` to `src/codegen/array-prototype-borrow.ts`
(#3264 extraction); re-anchored by symbol. Root cause confirmed: shape-inferred
receivers are **module globals** whose wasm type `object-shape-widening.ts`
already overrides to `ref_null <vecTypeIdx>`. So `compileArrayMethodCall`'s
existing receiver resolution (`resolveArrayInfoFromWasmType` over
`inferExpressionWasmType`) *already* recovers the exact vec arrInfo from the
global — no `ctx.shapeMap` plumbing into the resolver was needed.

Change (`compileArrayPrototypeCall`): the five methods that had clones
(`indexOf/includes/every/some/forEach`) now take the SAME synthetic-call rewrite
as the TS-type lane when the receiver is a shape-inferred global (gated by the
new `SHAPE_NATIVE_BORROW_METHODS` set). All other methods on a shape global
(`filter/map/reduce/reduceRight/find/findIndex` — no shape fast path) keep
falling through to the generic array-like loop, unchanged. The five
`compileArrayPrototype{IndexOf,Includes,Every,Some,ForEach}` clones plus their
now-unused imports (`emitReceiverNullGuard`, `nativeStringElementEqInstrs`,
`addStringImports`) were deleted.

- **-582 net LOC** in `array-prototype-borrow.ts` (2422 → 1840); 32 ins / 614 del.
- `npx tsc --noEmit` clean; `biome lint` + `prettier --check` clean.
- `scripts/prove-emit-identity.mjs check`: **IDENTICAL** across all 56
  (file,target) corpus emits — the deletion is surgical, no unrelated drift.

## Test Results

New `tests/issue-3193.test.ts` — 5 `assertEquivalent` cases exercising the
shape-inferred `Array.prototype.{indexOf,includes,every,some,forEach}.call(obj,…)`
lane (module-global widened receiver; found/missing/first-element, callback
with/without index, forEach accumulation). All 5 pass on the new routing.
Regression sweep over 10 related test files (issue-1022/1358/1360/1472/3049/
3139/3200/1234, check-regressions, shape-inference): the 10 pre-existing
failures on this local checkout are **identical with and without the change**
(verified by stashing the src edit) — zero new failures introduced.
