---
id: 2766
title: "Hybrid IR step 1: ElementAccess prove-then-specialize — vec.get only when in-bounds is proven, else SAFE bounds-checked read"
status: done
assignee: ttraenkler/sendev-2766
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, ir
language_feature: array-index
goal: correctness
related: [2755, 2760, 1530, 1131, 1804]
---

# #2766 — Hybrid IR step 1: ElementAccess prove-then-specialize

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

> **R1 handoff (from #2760, landed).** The legacy SAFE lowering to reuse is the
> helper `emitPlainArrayUndefinedOobGet` in `src/codegen/property-access.ts`
> (bounded read → box → `inBounds ? boxed : undefined`, emitted imperatively so
> no funcIdx is baked inside a branch). It is invoked as a **call-site-owned
> policy** from the two `compileElementAccessBody` plain-array read sites (the
> vec-struct path and the raw-array path), gated on
> `classifyTypedArrayType(...) === "other"`. Three carry-over lessons for the IR
> port: (1) the shared `emitBoundsCheckedArrayGet` default stays untouched — do
> not flip it (the S2 leak); (2) F1 widened **primitive** elements only
> (`number[]`/`boolean[]`) — externref `any[]`/`string[]` OOB→undefined is
> still DEFERRED here (it trips the map-on-array-like canary
> `15.4.4.19-8-b-2.js` via a pre-existing length-0 map result), and object
> (`ref`) arrays keep their typed result; (3) the widening is suppressed under a
> **numeric value-context hint** (`expectedType` f64/i32) — there `undefined`
> coerces to NaN (JS-correct) and, critically, keeping it unboxed avoids a late
> import shifting a funcIdx a numeric caller already captured (the Math.pow
> regression). The IR port should carry the same numeric-context discipline.

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

## Implementation Notes (sendev-2766, 2026-06-28)

**Folds in R1 (#2760).** Per the project-lead decision (1-A), the R1 legacy floor
fix (`emitPlainArrayUndefinedOobGet` + the two `compileElementAccessBody` call
sites, primitive-only, numeric-context-suppressed) is **merged into this PR**
rather than landing separately. `depends_on:[2760]` was dropped. R1's
`tests/issue-2760.test.ts` (19 tests) come along and stay green.

**Core change — `src/ir/from-ast.ts`:**
- `lowerElementAccess` no longer emits an unconditional (trapping) `emitVecGet`.
  It now: **prove → FAST**, else **SAFE**.
- **FAST** (`isProvenInBoundsIr`): the index is proven in `[0, length)` by the
  counted-loop proof — kept identical to the legacy `vec.get` (a single unchecked
  `array.get`, no bounds check; verified structurally: proven sum has
  `hasStructuredIf=false`, one `array.get`).
- **SAFE** (`emitSafeVecGet`): `inBounds ? vec.get(idx) : <JS-correct OOB default>`
  via `emitIfElse` (lazy — `select` would be wrong since it evaluates both arms and
  the read would still trap). **Crucially the result type is UNCHANGED** from the
  fast read (the element ValType), so there is **no downstream type cascade** —
  only runtime semantics change (trap → JS value).

**The proof (`detectCountedLoopSafeIndex` in `lowerForStatement`).** Ports legacy
`safeIndexedArrays` but is **deliberately STRICTER** (a *real* HI proof, not a
flag): legacy populated the set from only the `i < arr.length` condition + body
non-mutation, omitting the lower bound. The IR fast read emits an **unchecked**
`array.get` that *traps* on OOB, so the proof must also pin `0 <= i`: I additionally
require a non-negative-literal init **and** a strictly-increasing step (reusing
legacy `isIncreasingStep` / `loopBodyMutatesIndexOrArray`, now `export`ed). A
negative-init / decreasing loop therefore falls to the (correct) SAFE read instead
of being unsoundly trusted. The proof set is threaded onto a body-scoped `LowerCtx`
(`safeIndexedArrays`), immutably copied so it scopes to the loop and accumulates
outward through nesting.

**OOB-default element-kind dispatch (mirrors `lowerOptionalExternPropertyAccess`):**
- `f64` → `f64.const NaN` — `ToNumber(undefined)` is NaN, the JS-correct image in
  the numeric context the IR retains a primitive read in. **Stays unboxed: no late
  import is added, so R1's Math.* funcIdx-shift miscompile cannot recur on the IR
  path** (the whole reason R1 had to suppress widening in numeric context — the IR
  never needs to, because it never boxes).
- `i32` → `i32.const 0` (`ToBoolean(undefined)` = false; 0 for i32-specialized).
- `externref` → `ref.null.extern` — **matches legacy's non-widened externref OOB
  default (JS `null`)**, NOT `undefined`. This deliberately preserves R1's
  deferral: full externref OOB→`undefined` trips the map-on-array-like canary
  `built-ins/Array/prototype/map/15.4.4.19-8-b-2.js` via a separate length bug.
  Keeping the legacy value keeps that canary green; the trap is still removed.
- `ref_null` → `ref.null` of the element heap type.
- other (non-null `ref`, `i64`, packed `i8`/`i16`, `f32`) → demote to legacy
  (which bounds-checks all kinds, never traps): a null-ish default isn't
  expressible in an `if`-arm without widening the result to `ref_null`, which would
  cascade to consumers. **Verified the demote does not grow the ir-fallback budget
  (gate OK, all deltas 0)** — these element shapes don't reach the resolved-vec
  read in the playground corpus.

**Why no f64→externref box in the IR** (the constraint that shaped the design):
the IR has no `__box_number` primitive — a numeric→`any`/externref coercion
already demotes the whole function to legacy (`coerceReturnValue`, etc.). So a
`number[]` read whose result must be *observed* as `undefined` (a value context)
flows to an externref sink → demotes to **legacy F1** (correct, returns real
`undefined`). The IR only retains numeric-context reads, where `NaN` is the
JS-correct image. Net: every retained-on-IR path is JS-correct; every
undefined-observable path is handled by the folded-in legacy F1.

**Scope note (follow-ups):** (a) the literal-index P1 proof (`arr[k]`, `k < known
len`) is deferred — without static-length tracking in the IR it can't be
discharged soundly; the SAFE read covers literal indices correctly, just without
the fast path. (b) The array-destructuring read site (`from-ast.ts` ~`emitVecGet`
in the destructuring loop) still emits a trapping read for a too-short source —
distinct path, out of scope here. (c) Full externref OOB→`undefined` is the
R1-deferred follow-up gated on the map-on-array-like length fix.

**Validation:** `tests/issue-2766.test.ts` (12) + `tests/issue-2760.test.ts` (19)
green; 137 array/IR-slice tests green; `check:ir-fallbacks` OK (no growth, no
post-claim demotions); standalone mode SAFE read is valid Wasm and trap-free.
Broad-impact test262 + standalone-floor validated in `merge_group` (this is a core
IR change).

### merge_group regression fix (R1 F1 symbol-handle bug)

The first `merge_group` re-validation auto-parked on **one** real regression:
`built-ins/Object/values/symbols-omitted.js` (`Object.values({key: aSymbol})[0]
=== aSymbol`), pass→fail. Diagnosis (deterministic, NOT a flake — clean `main`
passes 10/10, branch failed 10/10; reproduced with `experimentalIR:false`, so the
cause is the folded-in **R1 legacy F1**, NOT the R2 IR change):

- `Object.values(...)` of a symbol-valued object is a `symbol[]`, which the
  compiler represents as an **i32 array of symbol HANDLES**. R1's F1 gate checked
  only the element's Wasm KIND (`arrDef.element.kind === "f64" | "i32"`), so it
  fired on the symbol-handle array and boxed the handle via
  `coerceType(i32→externref)` = **`__box_number`** — corrupting the symbol (clean
  main correctly uses **`__box_symbol`**). The `i32` kind is overloaded
  (`boolean[]` AND `symbol[]`/other handles are all i32), so the kind check alone
  can't honor R1's stated "number[]/boolean[] only" scope.
- **Fix (attempt 1, superseded):** gated F1 on the element-access TS type being
  number-like/boolean-like. This fixed the symbol case but KEPT boolean[].

### Second merge_group park — same root cause, boolean i32 (the deeper fix)

After attempt 1 the `merge_group` re-parked on **`merge shard reports` only**
(`check for test262 regressions` now PASSED — symbol fixed). The remaining failure
was the **STANDALONE lane** (`#1897` guard): **net -21**, all 21 in
`built-ins/Array/prototype/map/15.4.4.19-*` — `boolean[]` map results where
`result[0] === true` failed because R1's F1 boxed the boolean `true` (i32 1) via
`__box_number` → the number `1`, and standalone's native strict `===` gives
`1 !== true`. (js-host stayed green: in host the map result is an externref array,
so F1 never fired there — a host/standalone representation difference.) Confirmed
deterministic + `experimentalIR:false` → again the folded-in **R1 legacy F1**, not
the R2 IR change.

The root cause is the SAME systemic flaw: `i32` is overloaded (`boolean[]` AND
symbol-handle AND other handle reps), and `emitPlainArrayUndefinedOobGet` boxes
the in-bounds value with `coerceType(i32→externref)` = `__box_number` — only
correct for an actual number. Allowing boolean (attempt 1) still mis-boxed it.

- **Fix (final):** narrow F1 to the **`f64` (number[]) element ONLY** — drop `i32`
  from both `compileElementAccessBody` F1 branches (removed the TS-type helper;
  `f64` is unambiguously a number, so `__box_number` is always correct). `i32`
  elements (boolean[] / symbol-handle / other) and externref/object elements all
  fall through to the unchanged shared-helper read (bounds-checked, type-default
  OOB — never traps, matches pre-F1 `main`). `boolean[]` OOB→`undefined` is now
  **deferred** (was buggy in standalone anyway) until F1 boxes per the element's
  semantic type (`__box_boolean`/`__box_symbol`) — a follow-up for #2760.
- **Verified:** all 21 standalone map tests + the symbol test pass; **standalone
  diff vs baseline across map/Object.values/keys/entries = 0 new pass→fail
  regressions**; R1 number[] tests + R2 tests green (the boolean[]-OOB R1 test was
  updated to assert the deferred type-default); `check:ir-fallbacks` +
  `check:stack-balance` + biome + tsc clean. Local guard tests added to
  `tests/issue-2766.test.ts` (symbol identity + boolean map reads, host +
  standalone).

> **Note for #2760 rework:** R1's F1 boolean[]/symbol support needs a type-aware
> box (use the element's correct box fn, not the kind-based `coerceType`) before
> re-widening i32 elements. Filed as the follow-up scope above.
