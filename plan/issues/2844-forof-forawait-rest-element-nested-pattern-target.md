---
id: 2844
parent: 2669
related: [2602, 2826]
sprint: 69
status: done
completed: 2026-06-29
assignee: ttraenkler/restobj
priority: medium
horizon: m
area: codegen
language_feature: destructuring
goal: spec-completeness
---

# for-of / for-await array-pattern REST element bound to an OBJECT pattern is dropped

## Problem

A `for`-`of` / `for await`-`of` loop head whose array binding pattern has a REST
element bound to a **nested object pattern** silently drops the object-pattern
bindings:

```ts
for await (let [...{ 0: v, length: z }] of [[7, 8, 9]]) { /* v should be 7, z = 3 */ }
//                ^^^^^^^^^^^^^^^^^^^^^ rest collects [7,8,9] into a fresh Array A,
//                                      then { 0: v, length: z } destructures A:
//                                      v = A[0] = 7, z = A.length = 3
```

Observed on current main (`out = v*100 + z`):

| pattern                          | for-of | for-await |
| -------------------------------- | ------ | --------- |
| `[...{ 0: v, length: z }]`       | NaN    | NaN       |  <- bug (`v` dropped)
| `[...[a, b]]`  (array target)    | PASS   | PASS      |
| `[...rest]`    (identifier)      | PASS   | PASS      |

This is the concrete blocker for the test262 `*-ary-ptrn-rest-obj-{id,prop-id}`
cluster (for-of, for-await-of, async-gen/async-func variants) — found by impl2826
to fail HERE, before any iterator-capture concern.

Spec: §13.3.3.6 (8.5.2) IteratorBindingInitialization,
`BindingRestElement : ... BindingPattern` — the rest creates `Array A`, then runs
BindingInitialization of the inner BindingPattern with `A`.

## Root cause

The for-of / for-await loop head does NOT route array destructuring through the
shared `destructureParamArray` helper. It has its OWN array-destructure
reimplementation in `compileForOfDestructuring` (`src/codegen/statements/loops.ts`).

In the vec-array branch's rest-element handling, when the rest target is itself a
binding pattern it recurses generically:

```ts
// loops.ts ~1894 (before fix)
if (ts.isArrayBindingPattern(element.name) || ts.isObjectBindingPattern(element.name)) {
  compileForOfDestructuring(ctx, fctx, element.name, restIdx, restVecType, stmt);
}
```

- For an **array** sub-pattern this works: the recursion hits the vec-array branch
  and reads `A.data[i]`.
- For an **object** sub-pattern it breaks: the recursion hits `compileForOfDestructuring`'s
  object branch, which treats `restVecType` (the `__vec` struct `{length, data}`)
  as a plain named struct and resolves fields **by name** via `struct.get`. The vec
  struct has no field named `0`, so the numeric-key binding `0: v` is skipped and
  `v` keeps its NaN default. (`length: z` happens to coincide with the vec's real
  `length` field, so only the numeric keys are dropped.)

The function-parameter / `var`-decl lane (`destructureParamArray`,
`src/codegen/destructuring-params.ts`) already handles this correctly with
dedicated inline code that knows the rest vec is **array-like**: `length` -> vec
field 0, non-negative integer key `k` -> `A.data[k]` (OOB -> undefined). That lane's
`function([...{0:v,...}])` and `var [...{0:v,...}] = [...]` already pass. The for-of
lane simply lacks that array-like object-read.

## Fix

Extract the param lane's array-like object-from-vec read into a shared exported
helper `emitObjectPatternRestFromVec(ctx, fctx, vecLocal, vecTypeIdx, arrTypeIdx,
objPattern, isDecl)` in `destructuring-params.ts`, and call it from BOTH:

1. `destructureParamArray` (replaces the inline block — byte-identical output).
2. `compileForOfDestructuring`'s vec-array rest branch, for the object-target case
   (the array-target case keeps recursing, which already works).

Keyed on spec semantics (§13.3.3.6 array-like reads), not on Wasm kind. Scope
matches the cluster: shorthand / renamed identifier targets keyed by `length` or a
non-negative integer (OOB -> undefined). Rest-within-rest, nested sub-patterns, and
defaults *inside* the rest object stay as the prior param-lane behaviour (skipped) —
no regression, and out of the cluster's scope.

### Out of scope (pre-existing, not exercised by this cluster)

- The **tuple-struct** for-of branch (`loops.ts` ~1680) handles rest only for
  identifier targets via externref slice and does not recurse into a nested
  pattern at all. The cluster's RHS `[[7,8,9]]` is `number[][]` -> the **vec**
  branch, so the tuple branch is not hit. Tracked as a follow-up.

## Implementation

- `src/codegen/destructuring-params.ts`: new exported helper
  `emitObjectPatternRestFromVec(ctx, fctx, vecLocal, vecTypeIdx, arrTypeIdx,
  objPattern, isDecl)` — the array-like object-from-rest-vec read (`length` -> vec
  field 0, integer key `k` -> `A.data[k]` via `emitBoundsCheckedArrayGetUndef`,
  OOB -> undefined). Extracted from the inline block in `destructureParamArray`,
  which now calls the helper (behaviourally identical — param/var-decl lanes
  re-verified).
- `src/codegen/statements/loops.ts`: `compileForOfDestructuring` vec-array rest
  branch now splits the rest-target-is-pattern case — array sub-pattern keeps
  recursing (already worked); object sub-pattern routes through
  `emitObjectPatternRestFromVec` instead of the generic by-name struct destructure.
  Fixes both `for`-of and `for await`-of (all loop-head callers funnel through
  `compileForOfDestructuring`).

Import-neutral: standalone/WASI import sets are byte-identical to main; no new host
import. tsc + biome + prettier clean.

## Test Results

`tests/issue-2844.test.ts` — 11/11 pass. Scoped manual repro (host + WASI):

| case                                              | result |
| ------------------------------------------------- | ------ |
| for-of `[...{ 0: v, length: z }]`                 | 703 ✓  |
| for-await `[...{ 0: v, length: z }]`              | 703 ✓  |
| for-of full `[...{0:v,1:w,2:x,3:y,length:z}]` (y=undefined) | 107893 ✓ |
| for-of `[...{ length }]` shorthand                | 3 ✓    |
| for-of `[a, ...{ 0: b, length: z }]` (mixed)      | 7803 ✓ |
| for-await full cluster shape                      | 107893 ✓ |
| control: for-of `[...[a, b]]` (array target)      | 708 ✓  |
| control: for-of `[...rest]` (identifier)          | 703 ✓  |
| control: for-await `[...[a, b]]`                  | 708 ✓  |
| param lane `function([...{0:v,length:z}])`        | 703 ✓  |
| var-decl lane `var [...{0:v,length:z}] = [...]`   | 703 ✓  |

Regression batch (loadable dstr/for-of/rest tests): `class-dstr-rest-in-rest`,
`fn-param-dstr-rest-in-rest`, `issue-1128-dstr-tdz`, `issue-2602-forof-assign-rest`,
`issue-2158-dstr-param-default-nested-pattern`, `issue-1372-ir-destructuring-params`
— 40/40 pass. (`spread-rest.test.ts` and `*helpers.js`-importing files fail
identically on pristine main — pre-existing test-infra issues, unrelated.)

Authoritative test262 conformance validated by the `merge_group` full run.

### Follow-up

- The for-of **tuple-struct** branch (`loops.ts` ~1680) still handles rest only for
  identifier targets (externref slice) and does not recurse into a nested pattern.
  Not exercised by this cluster (`[[7,8,9]]` is `number[][]` -> vec branch). Track
  separately if a `[number,number][]` rest-to-pattern case surfaces.
