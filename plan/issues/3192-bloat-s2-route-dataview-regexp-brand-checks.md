---
id: 3192
title: "bloat S2: route DataView + RegExp brand checks through receiver-brand.ts"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: medium
task_type: refactor
area: codegen
es_edition: n/a
language_feature: brand-check
goal: maintainability
sprint: current
horizon: m
umbrella: 3182
depends_on: [3191]
related: [3171, 3173, 3029, 3102]
---

# #3192 — bloat S2: DataView + RegExp brand checks → receiver-brand.ts

Slice **S2** of the #3182 code-bloat-elimination epic. See #3182 §D2.
**Stacked on #3191 (S1)** — consumes S1's hoisted `js-errors.ts` leaf module;
claim after #3191 lands (or branch from its PR).

## Problem

`emitReceiverBrandCheck` / `emitReceiverBrandThrow`
(`src/codegen/receiver-brand.ts:58,146`, #3171) is the parameterized receiver
brand gate (struct `ref.test` + optional kind-tag refinement + catchable
TypeError). Already adopted by collections-brand, array-object-proto,
map-runtime, set-runtime, collections-es2025. NOT yet routed through it:

- **DataView brand gate** — `DV_BRAND_MESSAGE` (`src/codegen/dataview-native.ts:640`);
  hand-rolled test/throw around the #3173 templates (usages at
  `dataview-native.ts:1104`, `:1294`, `:1458`).
- **RegExp standalone brand check** — `src/codegen/regexp-standalone.ts:1022`
  (routes through native-proto's `emitBrandCheckTypeError`, the S1/D1 copy).

## Approach (verified anchors)

- Route both through `emitReceiverBrandCheck` / `emitReceiverBrandThrow`
  (`receiver-brand.ts:58/146`) with a struct-only `ReceiverBrandSpec` (no
  `kindField`) for `$__dataview` / the RegExp struct.

## Judgment gate (do not force-fit)

`receiver-brand` consumes a stack receiver INSIDE an fctx; the DataView
accessors build throw templates BEFORE the body (the pre-body ordering S1
preserves). If that ordering contract cannot be met without weakening
receiver-brand's API, **stop at S1's shared throw template** for DataView and
record the decision here — do not force-fit (that would be a worse coupling
than the dup). RegExp (native-proto route) is the cleaner half and can land
independently.

## Acceptance criteria

- Zero test-diff; brand TypeError messages byte-identical
  (`DV_BRAND_MESSAGE` string preserved verbatim).
- No new import cycles; `pnpm run typecheck` clean.
