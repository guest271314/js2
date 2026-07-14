---
id: 3276
title: "refactor: decompose compilePropertyAccess (property-access.ts mega-function)"
status: in-progress
sprint: current
priority: medium
horizon: l
feasibility: hard
model: opus
assignee: ttraenkler/Dev-WaveB-PropAccess
subtask_of: 3182
type: refactor
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
---

## Problem

`compilePropertyAccess` in `src/codegen/property-access.ts` is a single ~3,335-LOC
function (lines 2571–5905 on origin/main). It is the property-ACCESS-expression
compiler — DISTINCT from the property-access call-arm inside `calls.ts`'s
`compileCallExpression` (owned by a different Wave-B dev). It dispatches on access
kind / receiver type through a long sequence of independent early-return guard blocks
(TypedArray/DataView/ArrayBuffer buffer-attribute reads, `.constructor`/`.prototype`
identity fixups, Error member reads, identifier-namespace dispatch, `.length`/`.name`
families, struct-name resolution, and a terminal dynamic-member fallthrough).

This is Wave B (mega-function decomposition), subtask of #3182.

## Approach

Extract cohesive dispatch groups into named helper functions in a NEW sibling module
`src/codegen/property-access-dispatch.ts`, replacing each inline guard band with a
sentinel-guarded call. Each leading guard block is an independent
`if (guard) { …; return X }` / `if (guard) { …; if (r) return r }` — order-preserving,
so the extraction is a pure relocation.

### Sentinel protocol

`compilePropertyAccess` returns `ValType | null`, and `null` is itself a legitimate
result — so it cannot double as a "not handled" sentinel. The dispatch module defines:

```ts
export const PA_FALLTHROUGH: unique symbol = Symbol("property-access:fallthrough");
export type PADispatchResult = ValType | null | typeof PA_FALLTHROUGH;
```

Each extracted helper contains a verbatim run of the original guard blocks and returns
`PA_FALLTHROUGH` at the end (guard false / inner attempt produced nothing); every
original `return X` inside the band is preserved unchanged. Call site:

```ts
{
  const r = tryFooBar(ctx, fctx, expr, propName, objType);
  if (r !== PA_FALLTHROUGH) return r;
}
```

This is byte-for-byte equivalent to the inline band for every case (including an
explicit `return null`).

## Safety gate (non-negotiable)

Prove-emit-identity: `npx tsx scripts/prove-emit-identity.mjs write` BEFORE, then
`… check` AFTER each extraction MUST print IDENTICAL (39/39 gc/standalone/wasi).
`tsc --noEmit` stays at 0. Intra-function relocation is net-zero for the change-scoped
oracle ratchet; the loc-budget gate flags the new file (`loc-budget-allow` above).

## Slices

- **Slice 1** (this PR): leading buffer/TypedArray + `.constructor`/`.prototype`
  identity + JSON/Temporal/TextEncoder + Error-member guard families →
  `property-access-dispatch.ts`.
- Slice 2+ (stacked): identifier-namespace dispatch, `.length`/`.name` families,
  struct-name resolution / terminal dynamic-member block.

## Test Results

(recorded below as slices land)
