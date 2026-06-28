---
id: 2761
title: "Hybrid IR step 1: ElementAccess prove-then-specialize — vec.get only when in-bounds is proven, else SAFE bounds-checked read"
status: ready
sprint: current
created: 2026-06-28
updated: 2026-06-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, ir
language_feature: array-index
goal: correctness
related: [2755, 2760, 1530, 1131, 1804]
depends_on: [2760]
---

# #2761 — Hybrid IR step 1: ElementAccess prove-then-specialize

First IR-adoption step of the hybrid roadmap
([`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md),
§(b)). `ElementAccessExpression` is chosen first because it is the **sharpest HI
violation** with the **smallest SAFE-lowering gap**.

## Problem

The IR element read (`src/ir/from-ast.ts:1919` `lowerElementAccess` →
`emitVecGet` → backend `vec.get` → `array.get`) **traps on OOB** and *explicitly*
defers JS-correct OOB to the selector (comment at `from-ast.ts:1952–1960`:
"slice 12 doesn't add an explicit JS-style `undefined` return for OOB …
functions whose hot path indexes outside `[0,length)` should already be falling
back to legacy"). That is a pure **trust-the-type fast path with no SAFE
fallback** — strictly worse than legacy, which at least returns a (wrong)
sentinel. Under the hybrid invariant (HI) this is exactly the pattern we retire:
*specialize only when proven safe; otherwise lower the JS-correct way.*

## Implementation Plan

### The HI rule for this kind
- **FAST lowering** (`vec.get` / `array.get`, no bounds check): emit **only when
  the index is provably in `[0, length)`** at this site.
- **SAFE lowering** (bounds-checked read returning JS `undefined` on OOB):
  the default whenever the in-bounds proof cannot be discharged. This reuses the
  floor fix from **#2760** (F1) as the IR SAFE lowering — do **not** re-introduce
  a trapping read as the fallback.

### Proof primitive — port `safeIndexedArrays` into the IR
- Legacy already has the proof: `isSafeBoundsEliminated`
  (`src/codegen/property-access.ts:5371`) + `fctx.safeIndexedArrays`, populated
  by the counted-loop analysis (`array-element-typing.ts`
  `collectForCounterNames` / counter bounds). It records `arrayVar:indexVar`
  pairs proven `index < array.length`.
- Bring an equivalent in-bounds proof to the IR `lowerElementAccess` path:
  - **(P1)** literal index `k` with a statically-known length `len` and `0 ≤ k <
    len` (fresh `vec.new_fixed` array, #1804) → in-bounds.
  - **(P2)** counted-loop induction variable bounded by `array.length` (port the
    `safeIndexedArrays` set, or recompute on the IR via the loop's IR shape).
  - Otherwise → **not proven** → SAFE lowering.

### Changes
**File: `src/ir/from-ast.ts`**
- `lowerElementAccess` (line ~1919): replace the unconditional
  `emitVecGet(...)` (line ~1990) with a proof check:
  - if in-bounds proven (P1/P2) → `emitVecGet` (current fast path), keep.
  - else → emit the SAFE bounds-checked read (new IR lowering / shared helper)
    that returns `undefined` on OOB — the IR counterpart of #2760's F1 read.
- Remove the reliance on "the selector keeps OOB functions in legacy": once the
  SAFE lowering exists in the IR, OOB-indexing functions no longer need to demote
  to legacy for correctness. (Coordinate the selector/scope so this kind is
  promoted toward `ir-owned` per `plan/log/ir-adoption.md`.)

**File: `src/ir/backend/*` (emitter trait)**
- Add the SAFE bounds-checked-`vec.get`-with-undefined-OOB intent to the
  `BackendEmitter` trait if it is not expressible via existing intents, so both
  WasmGC and linear emitters can lower it (mirrors the #1714 vec-group two-
  backend pattern). If a thin composition of existing `emitVecLen` +
  `emitElemGet` + an if/else suffices, prefer that.

### #1530 alignment
This is the first concrete instance of the redefined IR fallback: *fall to the
SAFE JS-correct lowering, never the legacy trust-the-type path.* When the
ElementAccess rejection buckets reach zero and the only two outcomes are
FAST-with-proof or SAFE, promote the `ElementAccessExpression` row in
`plan/log/ir-adoption.md` and zero its bucket in
`scripts/ir-fallback-baseline.json`.

### Test gating
- No test262 regression in the `merge_group` re-validation.
- `pnpm run check:ir-fallbacks` must not grow any unintended bucket.
- A targeted IR test: an OOB dynamic read compiled via the IR returns
  `undefined` (not a trap), and an in-bounds counted-loop read still emits the
  no-bounds-check `array.get` (proof discharged).

## Acceptance criteria
- IR `lowerElementAccess` never emits a trapping OOB read; OOB → `undefined` via
  the SAFE lowering.
- Counted-loop / literal-bounded reads still get the fast `vec.get` (no perf
  regression on the proven-safe path).
- No net test262 regression; ir-fallback budget unbroken.
