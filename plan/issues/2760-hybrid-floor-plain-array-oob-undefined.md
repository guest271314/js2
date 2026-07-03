---
id: 2760
title: "Hybrid floor F1: plain-array OOB read → JS `undefined` (HI-style #2198/S2 rework, not the shared-helper flip)"
status: done
assignee: ttraenkler/senior-dev-2760
completed: 2026-06-28
sprint: 69
created: 2026-06-28
updated: 2026-07-03
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

## Implementation notes (senior-dev, 2026-06-28)

**What landed:** OOB→`undefined` for **primitive-element** plain arrays only —
`number[]` (f64) and `boolean[]` (i32), AND only when the element is read in a
**non-numeric value context**. The unproven (non-bounds-eliminated) read widens
its SAFE result to a **boxed-or-undefined externref** (box the in-bounds element;
OOB → `__get_undefined`, or `ref.null.extern` under standalone where
`undefined ≡ null`); the proven in-bounds read (`isSafeBoundsEliminated`, the
counted-loop proof) keeps the **unboxed fast path**. This is the hybrid
invariant in miniature: SAFE-by-default, FAST only when proven.

**Numeric-hint suppression (the second lesson — Math.\* regression).** The first
implementation widened *every* unproven primitive read to externref. The
`equivalence-gate` caught a regression: `Math.pow`/`min`/`max`/`hypot` with array
element args produced **invalid wasm**. Root cause: a numeric-consuming caller
like `compileMathCall` captures the host `Math_pow` funcIdx *before* compiling
its arguments; the externref widening adds a late import *during* arg
compilation, which shifts that already-captured funcIdx → a stale `call`. Fix:
**honor the value-context hint** — when the element is read into an `f64`/`i32`
context, suppress the widening and keep the unboxed read. There `undefined` is
unobservable anyway (it coerces to `NaN`/`0`, the JS-correct `ToNumber`), and the
unboxed read adds no imports, so no captured funcIdx shifts. `expectedType` is
threaded `compileExpressionInner → compileElementAccess →
compileElementAccessBody`. `=== undefined` / `typeof` / dynamic contexts pass no
numeric hint, so OOB→`undefined` still fires there. (Generalises the latent
"caller captures funcIdx before compiling args" fragility into a non-issue for
this path; the full `merge_group` test262 gate guards any other consumer.)

**Robust imperative boxing.** The helper emits the bounded read
(`emitBoundsCheckedArrayGet`, OOB→default, never traps) + box (`coerceType`) +
`undefined` (`emitUndefined`) **imperatively on `fctx.body`** so the late imports
register through the normal index-shift path; the final `inBounds ? boxed :
undefined` select-`if` carries only `local.get`. An earlier version that baked
the box/undefined funcIdxs into detached branch `Instr[]` desynced indices (a
duplicate `__box_number` import + a wrong arg value) — the same late-import-shift
hazard, avoided by never baking a funcIdx inside a branch array.

**Where:** a new call-site helper `emitPlainArrayUndefinedOobGet`
(`src/codegen/property-access.ts`) invoked from the two
`compileElementAccessBody` plain-array value-read sites (the vec-struct path and
the raw-array path), gated on `classifyTypedArrayType(...) === "other"` (plain
array, NOT a typed-array view) and, for the vec-struct path, excluding the
`$__regexp_match_vec` exotic. The shared `emitBoundsCheckedArrayGet` default is
**unchanged** — its `$__subview` / typed-array / array-method internal callers
are byte-identical. This is the HI-style rework the issue asked for, NOT the S2
shared-helper flip.

**Why externref (`any[]`/`string[]`) OOB→undefined was DEFERRED (the key
decision):** flipping externref OOB null→undefined regresses the S2 canary
`built-ins/Array/prototype/map/15.4.4.19-8-b-2.js`. Root cause, traced directly:
`var testResult = Array.prototype.map.call(obj, cb)` over a plain array-like
object produces a vec whose runtime **length is 0** (a separate, pre-existing
map-of-plain-object bug — verified: `(testResult as any).length === 0`), so the
asserted `testResult[2]` is an **OOB read**. The test passes today only by
accident: OOB externref → `ref.null.extern` → JS `null`, and the assert
`testResult[2] === false` coerces `null` to the expected `false`. Returning the
spec-correct `undefined` removes that accidental coercion (`undefined === false`
→ false) and the canary fails. Since the hard gate is "no net test262
regression," externref OOB→undefined is deferred to a follow-up that **first
fixes the map-of-array-like length bug** (or finds a provenance-based
discriminator). The behaviour is unchanged for externref arrays (still `null`),
so `any[]`/`string[]` OOB stays as-is — not a regression, just not yet fixed.

**Also observed (out of scope, noted for follow-up):** `typeof a[OOB]` folds to
the static element type's string (e.g. `"number"`) at compile time rather than
`"undefined"` — a separate static-type-trusting `typeof` unsoundness. The
element *value* is correctly `undefined`; only the `typeof` operator's
compile-time fold is wrong. Belongs to the same hybrid-soundness family but is a
distinct site (the `typeof` lowering, not the element read).

**Object-element arrays (`Foo[]`, `ref`/`ref_null` element):** intentionally
left unchanged. Widening their result to externref would break downstream
`a[i].field` (loses the struct type → no `struct.get`). Their OOB read keeps the
typed-null default (which traps on deref ≈ JS TypeError). Correct OOB→undefined
for object arrays needs the result type to become `Foo | undefined` (externref) —
that is the IR `prove-then-specialize` work (#2766), not a legacy floor fix.

**Validation:** new `tests/issue-2760.test.ts` (15 cases: primitive OOB→undefined
host+standalone, in-bounds preserved incl. boolean tag + counted-loop fast path,
typed-array unchanged, and the map-on-array-like canary guard). Targeted local
array/destructuring batches + the `tests/equivalence/` suite showed no new
failures (the only local failures are the pre-existing `tests/helpers.js`
infra-resolution issue and `fast-arrays > array find` / `array-capacity`, all of
which fail identically on clean `main`). Broad conformance validated by full CI /
`merge_group` (test262 regression gate + standalone-floor).
