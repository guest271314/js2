---
id: 3276
title: "refactor: decompose compilePropertyAccess (property-access.ts mega-function)"
status: done
completed: 2026-07-14
sprint: 72
priority: medium
horizon: l
feasibility: hard
model: opus
assignee: ttraenkler/Dev-WaveB-PropAccess
subtask_of: 3182
type: refactor
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
coercion-sites-allow:
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

### Slice 1 (PR — leading buffer/TA + constructor/prototype + JSON/Temporal/TextEncoder + Error bands)

Extracted 7 cohesive guard bands from `compilePropertyAccess` into the new
`src/codegen/property-access-dispatch.ts`:

| Helper | Original band | Families |
| --- | --- | --- |
| `tryDynamicReceiverRuntimeDispatchReads` | #3054 D / #3237 | dynamic-receiver TA ctor `BYTES_PER_ELEMENT`, TA view `byteLength`, DisposableStack `.disposed` |
| `tryConstructorPrototypeIdentity` | #2743/#2901/#2026/#3006/#3133/#2660 | `arguments.constructor(.prototype)`, `%TypedArray%` intrinsic ctor, tag-dispatch ctor identity, builtin/plain-object ctor singletons, fnctor `.prototype` |
| `tryPinnedAndDeleteAwareDynamicGet` | #2681/#2686/#2179 | pinned-struct member get, tombstone-aware dynamic get |
| `tryBuiltinNamespaceDeferredReads` | JSON/Temporal/TextEncoder | `JSON.parse` prop, Temporal prop, TextEncoder/TextDecoder read-only Web API props |
| `tryBufferViewAttributeReads` | #3054 B2/C / #2159/#3061/#2596/#3173 | `$__ta_view` accessors, `maxByteLength`/`resizable`, `byteLength`/`byteOffset` view semantics, `.buffer` |
| `tryStandaloneBuiltinAndWasiMemberReads` | #2175/#1914/#1780/#1482 | builtin-proto member meta/value, standalone RegExp reflection + match-result, `TextEncoderEncodeIntoResult`, `process.env` WASI |
| `tryNativeErrorMemberRead` | #1104/#1536c/#2077 | standalone/WASI native Error `message`/`name`/`stack` |

- `compilePropertyAccess` / `property-access.ts`: **7989 → 7107 LOC** (−882).
- New `property-access-dispatch.ts`: 1078 LOC (loc-budget allowance granted).
- Sentinel-guarded call sites (`PA_FALLTHROUGH`) preserve control flow exactly.
- **Byte-identity: IDENTICAL — all 39 (file,target) emits match baseline** (gc/standalone/wasi).
- `tsc --noEmit`: 0 errors. Gates green: loc-budget, oracle-ratchet (net +0),
  any-box-sites, coercion-sites, speculative-rollback, stack-balance, dead-exports,
  prettier.
- Smoke test `tests/issue-3276.test.ts`: 7/7 pass.

### Slice 2 (stacked on slice 1 — private/super + identifier-namespace + static-receiver bands)

Extracted 4 more cohesive guard bands into `property-access-dispatch.ts`:

| Helper | Families |
| --- | --- |
| `tryPrivateIdentifierRead` | #1365 private-name read with spec brand check |
| `trySuperAndImportMetaRead` | `super.prop`, `import.meta.*` |
| `tryGlobalThisAndProcessRead` | `globalThis.prop` (dual-mode), Node `process.argv`/`env`/`platform` |
| `tryIdentifierNamespaceAndStaticReceiverRead` | builtin-namespace `Builtin.prop`, enum member, static-`this`, static `ClassName.staticProp` |

- `property-access.ts`: 7107 → 6473 LOC (−634 in slice 2; **7989 → 6473 = −1516 cumulative**).
- New module: 1078 → ~1800 LOC (loc-budget allowance granted).
- **Byte-identity: IDENTICAL 39/39** (gc/standalone/wasi). `tsc --noEmit` 0.
  Gates green: loc-budget (net +293), oracle-ratchet (net +0), any-box-sites,
  coercion-sites, stack-balance, dead-exports, prettier.
- Smoke test: 11/11 pass.
- Stacked on slice 1's branch; PR opens once slice 1 merges. Remaining for later
  slices: `.length`/`.name`/string/iterator families + terminal struct-name block.

### Slice 3 (stacked on slice 2 — length/name/namespace-constant/string/iterator/extern-class bands)

Extracted 4 more cohesive guard bands into `property-access-dispatch.ts`:

| Helper | Families |
| --- | --- |
| `tryPrototypeMethodAndArityReads` | `ClassName.prototype.<method>` cached singleton (#1394), `Math.<method>.length` arity |
| `tryLengthAndNameReads` | `.length` (native-string value, Function/vec, generic) and `.name` reads |
| `tryNamespaceConstantAndSymbolReads` | tagged-template `.raw`, `Math`/`Number` constants, `Symbol.*`, symbol `.description` |
| `tryStringLengthIteratorAndExternClassReads` | String-wrapper `.length`, string `.length`, iterator-result `.value`/`.done`, external-declared-class member |

- `property-access.ts`: 6473 → 5573 LOC (−900 in slice 3; **7989 → 5573 = −2416 cumulative**; `compilePropertyAccess` itself ~3335 → ~900 LOC — only the preamble, the 15 sentinel-guarded call blocks, and the terminal struct-name/dynamic-member block remain inline).
- New module: ~1800 → ~2700 LOC.
- **Byte-identity: IDENTICAL 39/39** (gc/standalone/wasi). `tsc --noEmit` 0.
  Gates green: loc-budget (net +173), oracle-ratchet (net +0), any-box-sites,
  stack-balance, dead-exports, prettier.
- Smoke test: 13/13 pass.
- Stacked on slice 2; PR opens once slice 2 merges. Remaining: the terminal
  struct-name resolution + dynamic-member-get block (~800 LOC) as a possible slice 4.

### Slice 4 (stacked on slice 3 — terminal struct-name + dynamic member-get tail) — COMPLETES the decomposition

Extracted the entire terminal tail of `compilePropertyAccess` (the
`const typeName = resolveStructNameForExpr(...)` block through the final
`return { kind: "externref" }`) into `finalizeStructAndDynamicMemberGet`. Unlike
the guard bands, this region ALWAYS returns, so it is a plain tail-extraction —
the call site is `return finalizeStructAndDynamicMemberGet(...)` (no
`PA_FALLTHROUGH` sentinel); `typeName`/`accessType`/`accessWasm` become the
helper's own locals.

- `property-access.ts`: 5573 → 4773 LOC (−800 in slice 4).
- **`compilePropertyAccess` itself: ~3335 → 96 LOC** — only the preamble
  (optional-chaining / linear-U8 / `objType`+`propName`), the 15 sentinel-guarded
  guard-band call blocks, and the single terminal `return finalize(...)` remain.
- **Cumulative across all 4 slices: property-access.ts 7989 → 4773 LOC (−3216)**;
  the extracted logic now lives in `property-access-dispatch.ts` (16 named
  helpers) — a byte-for-byte-neutral reorganization.
- **Byte-identity: IDENTICAL 39/39** (gc/standalone/wasi). `tsc --noEmit` 0.
  Gates green: loc-budget, oracle-ratchet (net +0), any-box-sites, coercion-sites
  (moved `__to_primitive`/`__unbox_number` sites granted via `coercion-sites-allow`),
  stack-balance, dead-exports, prettier.
- Smoke test: 13/13 pass.
- Merge order: slice 2 (#3083) → slice 3 → slice 4. Slice 4 is the completing PR,
  so it carries `status: done`.
