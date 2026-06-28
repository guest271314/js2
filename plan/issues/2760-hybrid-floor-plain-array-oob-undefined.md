---
id: 2760
title: "Hybrid floor F1: plain-array OOB read → JS `undefined` (HI-style #2198/S2 rework, not the shared-helper flip)"
status: ready
sprint: current
created: 2026-06-28
updated: 2026-06-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-index
goal: correctness
related: [2755, 2198, 2754, 2698, 2001]
---

# #2760 — Hybrid floor F1: plain-array OOB read → JS `undefined`

Implements floor fix **F1** of the hybrid type-soundness roadmap
([`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md),
§(c)). This is the **HI-style rework** of the parked PR #2198 S2 slice — the
decision in [#2755](2755-evaluate-type-soundness-approach.md) is the **hybrid**,
under which OOB correctness must *fall out of the safe default element-read path*,
not be patched by toggling a shared low-level helper.

## Problem

A plain-array out-of-bounds value read (`const a: number[] = [1,4,5]; a[4]`) does
not return JS `undefined`. The bounds-checked path returns a **type-default
sentinel** — sNaN for `number`, `false` for `boolean`, `ref.null.extern` → JS
`null` for externref elements — never `undefined`. JS semantics: an absent index
reads as `undefined`.

## Why NOT the parked S2 approach

PR #2198 set `useUndefinedSentinel=true` on the **shared** helper
`emitBoundsCheckedArrayGet` (`src/codegen/array-methods.ts:386`). That helper is
also called by typed-array reads, the `$__subview` path
(`property-access.ts:6034`), and the array-method machinery. The flip perturbed a
generic `Array.prototype.map`-on-array-like path and regressed
`built-ins/Array/prototype/map/15.4.4.19-8-b-2.js` — the deciding data point that
"patch-the-holes on a shared representation" is leaky. **Do not re-land the
shared-helper flip.**

## Implementation Plan

### Root cause
The two non-bounds-eliminated element-read call sites in
`compileElementAccessBody` pass `useUndefinedSentinel=false`, so OOB yields the
type-default sentinel instead of `undefined`. Flipping the shared helper's
default is too broad (blast radius into typed-array/subview/array-method callers).

### Changes — scope the OOB→undefined policy to the call site

**File: `src/codegen/property-access.ts`**
- `compileElementAccessBody`, the two non-bounds-eliminated read sites:
  - typed-array element read at **line ~6303** (`emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef.element, ctx, false, taSignedness)`)
  - plain-array element read at **line ~6352** (`emitBoundsCheckedArrayGet(fctx, typeIdx, typeDef.element, ctx, false, taSignednessArr)`)
- Make the OOB→`undefined` decision an **explicit, call-site-owned** policy for
  the **dynamic plain-array value read** only. Two acceptable shapes:
  - **(a)** handle OOB→`undefined` at the `compileElementAccessBody` level
    (wrap/replace the plain-array call site) so the shared helper is untouched,
    or
  - **(b)** thread an explicit `oobPolicy` parameter the *caller* owns: plain
    dynamic reads pass `"undefined"`, the typed-array / `$__subview` / array-
    method internal callers keep their existing default.
- **Leave the typed-array read path on its own correct OOB semantics** (a typed-
  array OOB is `undefined` too, but it is reached through a different value-rep
  and must be verified independently — keep it out of F1's scope to avoid the S2
  blast radius). The `$__subview` call site (`property-access.ts:6034`) and all
  `array-methods.ts` internal callers MUST be unaffected.

### Edge cases
- Negative index (`a[-1]`) → `undefined` (the `i32.lt_u` bounds test already
  treats negatives as huge unsigned, so they hit the OOB branch).
- `number[]` OOB previously read sNaN → must now read `undefined` (representation
  changes from f64 to the externref `undefined` singleton; ensure the result
  ValType is handled by the caller — element access result may now be externref
  in the OOB-possible case, or boxed consistently).
- Hole-in-bounds (`[1,,3][1]`) keeps the existing `$Hole → undefined` mapping
  (`emitHoleToUndefined`); F1 is about *absent* (OOB), F2 is about *holes*.
- The `Array.prototype.map`-on-array-like case
  (`built-ins/Array/prototype/map/15.4.4.19-8-b-2.js`) MUST be green.

### Also (F2, F3 — small)
- **F2:** audit `emitHoleToUndefined` coverage for gaps in the typed-element
  (`number[]`/`boolean[]`) read paths (`array-methods.ts:481`).
- **F3:** add a doc-comment marking `emitThisReceiverGuardConvert`
  (`property-access.ts:5405`) as the **HI exemplar** (runtime `ref.test` instead
  of trusting the static type).

### Test gating
- No test262 regression in the `merge_group` re-validation.
- Targeted correctness: OOB plain-array reads return `undefined`; the
  map-on-array-like case flips/stays green.
- `.ts`/`.js` parity: the SAFE OOB read is identical for typed and untyped
  sources.

## Acceptance criteria
- `a[OOB]` on a plain `T[]` reads JS `undefined` (all element types).
- `emitBoundsCheckedArrayGet` shared default is **unchanged**; typed-array /
  subview / array-method internal callers are byte-identical.
- `built-ins/Array/prototype/map/15.4.4.19-8-b-2.js` is green; no net test262
  regression.
