---
id: 3192
title: "bloat S2: route DataView + RegExp brand checks through receiver-brand.ts"
status: done
completed: 2026-07-14
created: 2026-07-12
updated: 2026-07-19
priority: high
feasibility: medium
task_type: refactor
area: codegen
es_edition: n/a
language_feature: brand-check
goal: maintainability
sprint: 72
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

## Resolution (2026-07-14)

**RegExp — routed (the clean half).** `recoverRegExpStructFromExternref`
(`regexp-standalone.ts`) previously hand-rolled the §22.2.6 brand gate
(`any.convert_extern` → `ref.test $NativeRegExp` → `i32.eqz` → `if` throw via
native-proto's `emitBrandCheckTypeError` → `ref.cast`). It now delegates the
entire gate to the shared `emitReceiverBrandCheck` (`receiver-brand.ts`, #3171)
with a **struct-only** `ReceiverBrandSpec` (RegExp has no shared backing store,
so no `kindField`). The externref `this` is pushed on the stack, the preamble
throws a catchable TypeError on a miss (message preserved verbatim:
`"Method called on incompatible receiver (RegExp brand check failed)"`) and
leaves the recovered `(ref $NativeRegExp)` on the stack, which the function then
stashes in a typed local — identical observable behaviour. The now-unused
`emitBrandCheckTypeError` import was dropped. Validated: `tests/issue-3192.test.ts`
plus the existing `issue-2175-native-proto-brands` (5), `issue-2876` (8) and
`issue-2161-regex-symbol-protocol` (14) suites all green; typecheck clean; no
new runtime import cycle (`receiver-brand.ts` is a leaf — its only regexp edge
is a pre-existing type-only import in `context/types.ts`, erased at runtime).

**DataView — deliberately NOT routed (judgment gate hit).** The DataView
accessors (`dataview-native.ts`) build the brand throw as a **template `Instr[]`
(`dvTypeErrorThrow(ctx, DV_BRAND_MESSAGE)`) BEFORE the accessor body** — the
funcIdx-capture ordering S1 preserves (`__new_TypeError` / `emitWasiErrorConstructor`
push must precede any later funcIdx capture) — and then weave that template into
a hand-built `if (not $__dv_window) <brandThrow>` that shares its single
`$__dv_window` `ref.test` result with the detached-buffer and bounds checks (and
reads the view length / buffer off the same narrowed struct). `emitReceiverBrandCheck`
consumes a **stack receiver inside the fctx**, runs its **own** `ref.test`, and
emits the throw **inline** (not as a pre-built, reusable template) — so adopting
it here would either (a) force a second redundant `ref.test`, (b) break the
pre-body template-ordering contract, or (c) require weakening receiver-brand's
API to hand back a template. All three are worse couplings than the current
tiny dup. Per the issue's explicit judgment gate we **stop at S1's shared throw
template for DataView**: its throw already routes through S1's
`buildThrowJsErrorInstrs` (#3191) via `dvTypeErrorThrow`, so the DataView brand
throw is already de-duplicated at the throw-builder layer; only the gate
structure stays local. `DV_BRAND_MESSAGE` unchanged; DataView brand behaviour
locked by `tests/issue-3192.test.ts`.
