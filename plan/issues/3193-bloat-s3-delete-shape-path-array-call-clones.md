---
id: 3193
title: "bloat S3: delete the 5 shape-path Array.prototype.*.call clones, route through the synthetic-call rewrite"
status: in-progress
assignee: dev-3193
created: 2026-07-12
updated: 2026-07-17
priority: medium
feasibility: medium
task_type: refactor
area: codegen
es_edition: n/a
language_feature: array-methods
goal: maintainability
sprint: current
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
