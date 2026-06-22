---
id: 2106
title: "value-rep P3: undefined observability — UNDEF_F64 sentinel, union-collapse reversal (flagged), standalone $undefined singleton"
status: in-progress
assignee: ttraenkler/sdev7
sprint: 65
created: 2026-06-11
updated: 2026-06-18
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2004, 2051, 2030, 2001]
origin: "2026-06-11 analysis program (report 02 phase P3); stub 08-E21"
---

# #2106 — T | undefined collapses to bare T

## Problem

`T | undefined` collapses to bare T at the type mapper, so undefined
becomes NaN/0 in numeric carriers and is unobservable to `===`/`??`/`?.`/
typeof/ToString (#2004 codePointAt, optional-chain representation #2051
slug, #2030 exhausted .value, the #2001 destructuring addendum). In
standalone mode `undefined` and `null` are the SAME bit pattern
(ref.null extern) — indistinguishable by construction.

## Root cause

Union collapse at index.ts:9108-9117 / type-mapper.ts:79-99; observers
never check the existing sNaN sentinel; late-imports.ts:535-543
null-extern fallback. No standalone `$undefined` singleton.

## Fix direction

Per the value-rep spec P3: standardize the sNaN sentinel
(0x7FF00000DEADC0DE) for `number|undefined` carriers with observer
support; reverse union collapse behind a feature flag with measured
blast radius; add the standalone tag-1 `$undefined` singleton global.
Erasure stays for pure ToNumber/ToBoolean sinks (proven sound).

## Acceptance criteria

- `codePointAt(oob) ?? -1`, `=== undefined`, typeof, and stringification
  observe undefined in both modes; null vs undefined distinct standalone
- Flag-gated collapse reversal lands with perf/size measurements

## Ownership reconcile (#2142, 2026-06-15) — READ BEFORE DISPATCH

#2142 reconciled the two-document conflict (this issue's `UNDEF_F64` sentinel
vs #2051's externref widening). Authoritative decision in
[`2142-undefined-rep-owner-reconcile.md`](2142-undefined-rep-owner-reconcile.md#decision-authoritative--2026-06-15-arch1).
Net effect on this issue's scope:

**Decision rule:** widen to **externref + host `undefined`** when the value
must be observable to `===`/`!==`/`typeof`/ToString/`??`; use the **sNaN
sentinel** only inside hot f64 carriers whose sole consumer is
`emitDefaultValueCheck` (destructuring/default-parameter reads, array/tuple
holes).

**Producer list — #2051's sites are REMOVED from this issue.** The
optional-chain short-circuit sites (`a?.b` / `a?.[i]` / `a?.m()`) are owned by
**#2051** (externref widening, per its own `## Implementation Plan`). Do **not**
apply the `UNDEF_F64` sentinel to optional-chain sites — that channel cannot
reach `===`/`typeof`/ToString (verified: `=== undefined` on an f64 is
unconditionally `false`, `binary-ops.ts:479-482`; the sNaN sentinel is observed
*only* by `emitDefaultValueCheck`, `shared.ts:418`).

**This issue's remaining scope after the reconcile is three disjoint pieces:**

1. **General `number|undefined` observability → externref.** For
   `number|undefined` carriers consumed by `===`/`!==`/`typeof`/ToString/`??`
   (NOT optional-chain — those are #2051), widen to externref + host
   `undefined`, composing with the #2072/#2104 value-rep boxing. This is the
   same mechanism #2051 uses, applied to the non-optional-chain producers.
2. **Codify the sNaN sentinel carve-out (erasure stays).** The existing
   `0x7FF00000DEADC0DE` sentinel for default-check / hole carriers
   (`type-coercion.ts:2672`, `emitDefaultValueCheck`) is **kept** — erasure is
   proven sound for pure ToNumber/ToBoolean and default-initializer sinks. Do
   not widen these to externref (hot path, zero observability gain).
3. **Standalone `$undefined` singleton.** Add the standalone tag-1 `$undefined`
   global so `undefined` is distinct from `null` in standalone mode
   (`late-imports.ts:553-571` currently falls both back to `ref.null extern`).
   This is orthogonal to the host-vs-sentinel choice and aligns with #2104's
   JsTag module.

**Do NOT re-claim `codePointAt(oob) ?? rhs`** — already shipped via the
`??`-site NaN special-case (`logical-ops.ts:208-216`, `isCodePointAtCall`);
#2004 is `done`. Neither this issue nor #2051 touches it.

The flag-gated union-collapse reversal (index.ts:9108-9117 /
type-mapper.ts:79-99) stays in this issue's scope and lands with the
perf/size blast-radius measurement as the acceptance criteria require.

## Dupe check

Symptom issues filed; the representation phase is unfiled. New (analysis
program).

## Implementation Plan — 4 slices (sdev1, 2026-06-15)

Decomposed per the #2142 authoritative reconcile (3 disjoint pieces + the
flag-gated reversal). Each slice is an independently green-mergeable PR. Built
on #2104's `value-tags.ts` (`JsTag.Undefined`, `boxToAny`). Slice order is
risk-ascending.

### S0 — array-element boolean tag-recovery (cleanest first slice; tag-recovery root)  ← START HERE

Per the tech-lead's reframe (own the `any`=externref / tag-recovery root, not the
literal "undefined" text), the cleanest highest-leverage entry point is a pure
`boxToAny(jsStaticType)` application — no representation widening, no flag.

**Concrete bug (host mode, verified @ 2026-06-16):** a boolean stored in `any[]`
loses its tag on read-back —
- `const a: any[] = [true]; typeof a[0]` → `"number"` (should be `"boolean"`)
- `const a: any[] = [true]; "" + a[0]` → `"1"` (should be `"true"`)
- string/number elements are fine; `a[0] === true` is fine (so the value is
  stored, only the TAG is wrong).

**Root cause (WAT-confirmed):** the array-literal `[true]` builds an i32 array,
then the typed-array→`any[]` promotion copy-loop boxes each element by **Wasm
kind**: `array.get; f64.convert_i32_s; call __box_f64` → tag-3 **number** instead
of tag-4 boolean. This is the §1.1 "i32 boxes as number" disease at the
**vec→any-vec coercion** site (a `coerceType(elem→AnyValue)` inside the array
promotion, NOT the literal fast-paths).

**Fix:** thread the source array's **element static type** into that box site and
call `boxToAny(ctx, fctx, from, jsStaticType(elemType))` (#2104 API) — `[true]`'s
element type is `boolean` → `__box_bool` (tag 4). Find the vec→any-vec promotion
copy-loop emitter (grep the `array.new_default` + per-element box near the
typed-array→`any[]` coercion in `type-coercion.ts`/`literals.ts`); pass the TS
element type already available at the coercion call site. Smallest, safest
tag-recovery slice; pure #2104 composition; host-reproducible test gate.

#### S0 fix-site correction (sdev7, 2026-06-16 — investigated before #1503 merged)

The plan's "thread the TS element type into the vec→any-vec copy-loop
(`emitVecToVecBody`)" is **not viable at that site** — I traced it end to end:

- The actual lossy box is at `type-coercion.ts:887`, inside `emitVecToVecBody`,
  reached via `coerceType → emitSafeStructConversion (type-coercion.ts:680-704)`.
  That whole path is **purely Wasm-type-driven** (it works from `fromTypeIdx`/
  `toTypeIdx` and `getVecInfo`'s `ValType` element only). The TS `boolean` type is
  already fully erased there.
- **WAT-confirmed the disease**: `[true]` builds `__vec_i32` (`array.new_fixed
  10 1`), then the copy-loop does `array.get 10; f64.convert_i32_s; call 1`
  (`__box_number`, tag 3). And critically: **`boolean[]` and `number[]` SHARE
  `__vec_i32`** — the vec types are named by Wasm kind (`__vec_i32`/`__vec_f64`/
  `__vec_externref`), there is NO `__vec_boolean`. So the boolean tag is
  irrecoverable from the source vec type alone at `emitVecToVecBody`.

**Correct fix site = `compileArrayLiteral` (`literals.ts:2691`), not the
coercion.** The literal already calls `getContextualType(expr)` and the
per-element TS types are available there (`getTypeAtLocation(el)`). For `[true]`
the contextual type IS `any[]`, but the element-type selection at
`literals.ts:2872-2933` only adopts the contextual element type when the first
element resolves to a **ref** (`:2886` guard) — `boolean→i32` is not a ref, so
the `any` context is dropped and `elemWasm` stays `i32`, building `__vec_i32` and
deferring the lossy coercion. **Fix:** when the contextual element type is `any`
(`isAnyValue` of the resolved contextual element, or `getContextualType` element
= `any`), set `elemWasm` to the `$AnyValue` ref type and, in the non-spread
element loop (`:2942-2961`), box each element with
`boxToAny(ctx, fctx, <elemWasm-of-el>, jsStaticType(getTypeAtLocation(el)))`
instead of `compileExpression(…, elemWasm)` + a downstream Wasm-kind coerce. This
builds an AnyValue-vec directly with the right per-element tag (`true`→tag-4),
eliminating the i32-vec→any-vec coercion for this shape entirely. It is the spec
§2.2 literal-fast-path pattern #2104 already preserves, extended to the `any[]`
target. Scope strictly to `contextual elem === any` so number[]/string[]/struct[]
vecs are byte-identical (no blast radius outside `any[]` literals). Test gate:
the host repros above + a standalone variant; guard the heterogeneous mixed case
`[true,1,"x"]` (each element boxed by its own `jsStaticType`).

### S1 — standalone `$undefined` singleton (so undefined ≠ null in standalone)

- **Today**: `emitUndefined` (`src/codegen/expressions/late-imports.ts:563`)
  falls back to `ref.null.extern` in `nativeStrings`/standalone — undefined and
  null share the bit pattern. `ensureGetUndefined` (:553) returns undefined in
  standalone; `__extern_is_undefined` standalone convention is bare
  `ref.is_null` (so it can't tell them apart).
- **Change**: add an immutable module global `$undefined : ref $AnyValue` (tag 1,
  built via the tag-1 box / `JsTag.Undefined`), emitted once lazily (like
  `ensureAnyValueType`). Standalone `emitUndefined` returns `global.get
  $undefined` instead of `ref.null.extern`. Standalone `__extern_is_undefined`
  becomes "ref.eq against `$undefined`" (or tag==1 check) rather than
  `ref.is_null`. `null` stays `ref.null.extern`.
- **HAZARD (#329, documented at late-imports.ts:545)**: introducing a
  standalone undefined value that is NOT `ref.null.extern` must NOT add a late
  import *after* the native-string helpers are emitted — that drives
  `reconcileNativeStrFinalizeShift` an extra time and off-by-ones the baked
  `__str_flatten`→`__str_copy_tree` call. Mitigation: the `$undefined` global is
  a GLOBAL (not a func import) and must be reserved up-front (at
  `ensureAnyValueType` time), so no late func-index shift. Verify with the #329
  repro (`let g: any; g = function(){…}; g()`) standalone.
- **Blast radius**: `emitUndefined` callers (28 `__get_undefined` sites) +
  standalone `__extern_is_undefined` consumers (~10 files). Gate every change on
  `ctx.standalone`/`nativeStrings` so host mode is byte-identical.
- **Test gate**: `(undefined === null)` → false, `(undefined == null)` → true,
  `typeof undefined` → "undefined" vs `typeof null` → "object", all standalone.

### S2 — codify the sNaN sentinel carve-out (erasure stays)

- Document + guard the existing `0x7FF00000DEADC0DE` sentinel
  (`type-coercion.ts:2672`, `emitDefaultValueCheck` at `shared.ts:418`,
  consumers at `destructuring-params.ts:830`, `literals.ts:1759/2317/2886`) as
  the ONE sanctioned f64-undefined channel — sole consumer
  `emitDefaultValueCheck`. Route it through `value-tags.ts`'s `UNDEF_F64_BITS` /
  `pushUndefF64` / `emitIsUndefF64` (P1 already centralized these). No behaviour
  change — consolidation + a comment/invariant that these f64 carriers are
  default-check-only and must not be widened. Small.

### S3 — general `number|undefined` → externref widening (NON-optional-chain)  ← HIGHEST IMPACT, host-reproducible

**Concrete failing cases (host mode, verified on the #2104 branch @ 2026-06-16)
— these are the S3 test gates:**

| Repro | Got | Expect | Why |
|---|---|---|---|
| `[1,2,3].find(x=>x>5) === undefined` | `0` (false) | `1` | `find` miss returns the f64 NaN-sentinel, not observable undefined |
| `function f(x?: number){return x ?? -1} f()` | `NaN` | `-1` | optional numeric param absent → f64 NaN-sentinel; `??` short-circuits "never nullish" on f64 (`logical-ops.ts:188-191`) |
| `typeof [1].find(x=>x>5) === "undefined"` | `0` | `1` | typeof of the f64 carrier can't observe undefined |

`Map.get` miss already works (returns externref). So the broken producers are
the ones carrying `T|undefined` as **bare f64**: `Array.find`/`findLast`-family
(`array-methods.ts`) and **optional numeric parameters** (param prologue /
`destructuring-params.ts`). NOT optional-chain (#2051), NOT default-check
carriers (S2 keeps the sentinel there).

- **Fix (per #2142 rule)**: widen these carriers to externref + host `undefined`
  (host) / `$undefined` tag-1 (standalone, needs S1), composing with
  #2072/#2104 `boxToAny`. Producers emit `emitUndefined` (externref) for the
  absent case instead of `f64.const NaN`; their result ValType becomes externref
  so the existing externref-aware `===`/`??`/`typeof` observers (already
  discriminate, #2142 fact 1) light up with zero new observer code. Reuse
  #2051's widening mechanism (`variables.ts:100-102` `isNullablePrimitiveType`).
- **Watch**: changes `find`/optional-param result type f64→externref — measure
  the test262 delta (arithmetic-on-find-result may need an unbox). Medium-risk;
  gate carefully.
- **Decision rule (from #2142)**: widen when observable to the general
  nullish/identity/stringify set; sentinel only for the S2 default-check carriers.

### S4 — flag-gated union-collapse reversal (RISKY, last)

- The blanket `T|undefined`/`T|null` → bare `T` collapse at
  `index.ts:9108-9117` (`resolveWasmType`) / `type-mapper.ts:79-99`
  (`mapTsTypeToWasm`) is the erasure factory. Reverse it **behind a feature
  flag**, only for Null/undefined-bearing unions where observability is needed
  (rule §2.4(3)), and **measure perf/size + test262 blast radius before
  default-on** (acceptance criterion). This is the only slice with uncertain
  test262 delta — flag + measure-first protocol is mandatory.

### Sequencing / notes

- All slices need #2104 (`value-tags.ts`) merged. Build stacked on the #2104
  branch until #1503 lands, then branch from origin/main.
- S1 + S2 are clean/self-contained; S3 is medium; S4 is the risky flagged one
  and should land last with measurements. Recommend S3/S4 get fresh
  max-reasoning context.
- `codePointAt(oob) ?? rhs` is already done (#2004, `logical-ops.ts:208`) —
  do NOT re-represent it. Optional-chain sites are #2051 — do NOT touch.

## S3 producer map (sdev7, 2026-06-16) — exact sites, verified on main @ 24e520df8

Confirmed the S3 host repros still fail and pinned the producers, so S3 is
turnkey for its own focused (measure-first) PR:

**Repros (host, all reproduce):**
- `[1,2,3].find(x=>x>5) === undefined` → `0` (want `1`)
- `typeof [1].find(x=>x>5)` → `"number"` (want `"undefined"`)
- `function f(x?:number){return x ?? -1} f()` → `NaN` (want `-1`)
- `function f(x?:number){return typeof x} f()` → `"number"` (want `"undefined"`)
- `function f(x?:number){return x === undefined} f()` → `0` (want `1`)
- Working (keep green): `f(5)`→5, `f(0) ?? -1`→0 (0 is not nullish), `find` HIT
  cases, the generic externref-array `find` (already `ref.null.extern`).

**Producer 1 — typed/numeric `find`/`findLast` fast-path.** The GENERIC array
`find` (`array-methods.ts:856`) already returns `externref` with a
`ref.null.extern` miss — but the numeric/typed fast-path returns an **f64 NaN
sentinel**: `array-methods.ts:6522-6529` (`find`) and `:6712-6719` (`findLast`):
`findResType = ctx.fast ? elemType : { kind: "f64" }`, miss = `f64.const 0;
f64.const 0; f64.div` (NaN). For `number[]` the result local is f64
(WAT-confirmed: `$__arr_find_res_9 f64`), so the miss is unobservable to
`===`/`typeof`/`??`. Widen the **non-fast** branch's miss to `emitUndefined`
(externref) and the result type to externref; the `ctx.fast` i32 branch is a
separate (native-int) story — scope carefully.

**Producer 2 — absent optional numeric parameter.** `f(x?: number)` called with
no arg materializes `x` as an f64 NaN sentinel (param prologue /
`destructuring-params.ts` default-fill), so `x ?? -1`→NaN, `typeof x`→"number",
`x === undefined`→false. Widen the absent-optional-numeric-param carrier to
externref + host `undefined` (standalone needs S1's `$undefined`).

**Mechanism (per #2142 rule):** both producers emit `emitUndefined` (externref)
for the absent case instead of `f64.const NaN`; result ValType becomes externref
so the existing externref-aware `===`/`??`/`typeof` observers light up with zero
new observer code (#2142 fact 1). Reuse #2051's widening helper
(`variables.ts` `isNullablePrimitiveType`).

**RISK / measure-first (why this is its own PR):** changing `find`/optional-param
result type f64→externref means any **arithmetic** on the result needs an unbox
(`arr.find(...) + 1`, `f() * 2`). Must measure the test262 delta before
default-on; gate carefully and check the arithmetic-on-result paths. Standalone
correctness depends on S1 (`$undefined` ≠ `null`). Recommend: land S1 first (or
concurrently), then S3 with a CI-measured blast radius.

### S3 Producer-1 attempt + box-protocol blocker (cs-2158, 2026-06-18)

Attempted S3 Producer-1 (find/findLast numeric miss → externref) in isolation:
widened the **non-`ctx.fast`** branch of `compileArrayFind`/`compileArrayFindLast`
(`array-methods.ts`) so the result carrier is externref — found element boxed via
`coerceType(elemType→externref)`, miss = `emitUndefined`, return type externref.
**Partial success:** `typeof [1].find(x=>x>5)` correctly became `"undefined"`.
**But a runtime regression blocks it:** even a plain HIT (`[1,2,3].find(x=>x>1)!`
→ expect 2) and `findLast` HIT throw `RuntimeError: dereferencing a null
pointer` at runtime, through the real equivalence harness (not a probe-env
artifact). The emitted WAT looked correct in isolation (`local.set $res
(call $__box_number $elem)` on hit, `call $__unbox_number $res` on return), so
the null-deref is a **box/unbox-protocol mismatch** between the find-result
externref and how the consuming numeric/`!`-assertion context unwraps it (the
`__box_number`↔`__unbox_number` round-trip derefs null in this configuration —
likely a `$AnyValue`-struct vs host-box shape mismatch, or a double-unbox via the
`!` + numeric coercion path). `Map.get` miss `=== undefined` works (externref
baseline), so externref *results* are consumable — the break is specific to the
find-result→numeric-consumer coercion.

**Conclusion:** S3 is NOT a tractable single slice — it needs dedicated
max-reasoning work to align the find-result box protocol with the numeric
consumer/`!`-assertion unwrap (and likely should land **after/with S1** and a
measured test262 run, as the plan already says). Reverted the attempt cleanly
(no code landed). Next agent: investigate why `__unbox_number(__box_number(x))`
null-derefs in the find-HIT consuming context before re-widening — that
box-protocol fix is the real prerequisite, not the find emit site itself.

## S1 — Architect spec: standalone tag-1 `$undefined` singleton (sdev-async, 2026-06-23)

Promoted from "fix direction" to a concrete, ripple-mapped implementation plan
after the **S1a hold** (PR #1961) proved no inline strict-eq fix can split
null/undefined while they share the `ref.null extern` bit pattern. S1 gives
`undefined` a **distinct representation** so all four nullish strict-eq cases —
and `typeof`, `Object.is`, `in`-vs-undefined — resolve correctly. Verified
against `origin/main` @ `c8cd5ba8f`; re-grep anchors if drifted.

### The core decision: undefined = a tag-1 `$AnyValue` singleton; null = `ref.null extern`

In standalone (`ctx.nativeStrings`/`ctx.standalone`) there is no host `undefined`.
Today `emitUndefined` (`late-imports.ts:596`) falls back to `ref.null.extern` —
**identical to `null`**. The fix: a single immutable module global
`$undefined : (ref $AnyValue)` holding a **tag-1** box
(`{tag:1, i32val:0, f64val:NaN, refval:null, externval:null}` — the exact shape
`__any_from_extern`'s `nullAny` already synthesises at `any-helpers.ts:186-193`).
`null` stays `ref.null extern`. The two are then distinguishable everywhere a
value flows as an externref/anyref because undefined is a *non-null* ref to the
singleton, while null is a true null.

### HARD CONSTRAINT — the null-vs-undefined RIPPLE is the whole difficulty

This is NOT a localised change. The blast radius (measured on `origin/main`):
- **33** `emitUndefined(...)` call sites (the producers).
- **35** `__extern_is_undefined` emit sites + its native impl (`index.ts`
  registers it as bare `ref.is_null` in standalone — `index.ts:4300` comments
  the convention).
- **42** `ref.is_null` uses across `src/codegen/`, of which **~13** are
  *undefined-specific* checks and the rest are genuine null / generic-nullish
  checks.

The danger: making undefined a non-null singleton **breaks every `ref.is_null`
site that currently relies on "undefined IS null"** to detect undefined. Those
fall into three classes that MUST be triaged individually:

1. **Genuine nullish checks (`== null`, `?.`, `??`, default-value fill,
   array-hole, `Object.is` SameValueZero on nullish)** — these want BOTH null and
   undefined to count. After S1 a bare `ref.is_null` no longer catches the
   undefined singleton, so each must become `is_null(x) || is_undefined_singleton(x)`.
   **This is the dominant ripple and the #1 regression source.** Centralise it:
   add `emitIsNullish(ctx, fctx)` (= `ref.is_null` OR ref.eq-against-`$undefined`)
   and route every nullish consumer through it.
2. **Undefined-specific checks (`=== undefined`, `typeof x === "undefined"`,
   `void`-result, optional-param absence)** — these want ONLY undefined. After S1
   they become `is_undefined_singleton(x)` (ref.eq vs `$undefined` / tag==1),
   NOT `ref.is_null`. The `__extern_is_undefined` native impl flips from
   `ref.is_null` to the tag-1 check.
3. **Null-specific checks (`=== null`, `typeof x === "object" && !x`)** — want ONLY
   null. These STAY `ref.is_null` AND must additionally EXCLUDE the undefined
   singleton (a non-null ref) — which they already do, since the singleton is
   non-null. Low risk; audit only.

### HAZARD — #329 native-string finalize shift (documented at late-imports.ts:581-584)

A standalone undefined value that is NOT `ref.null extern` must NOT be introduced
via a **late func import added AFTER the native-string helpers are emitted** — that
re-drives `reconcileNativeStrFinalizeShift` and off-by-ones the baked
`__str_flatten`→`__str_copy_tree` call (#329 repro: `let g: any; g = function(){…};
g()` → invalid wasm). Mitigation: `$undefined` is a **GLOBAL**, not a func import,
and is reserved **up-front at `ensureAnyValueType` time** (`any-helpers.ts:23`) so
no late func-index shift occurs. The global's init (a `struct.new $AnyValue`) is a
constant expression — emit it in the module's global-init, never lazily mid-body.

### Staged plan (each stage independently green-mergeable; gate every change on `ctx.standalone`/`nativeStrings`; host mode byte-identical)

- **S1.0 — reserve the singleton (INERT).** At `ensureAnyValueType`, also register
  the `$undefined` global (tag-1 `$AnyValue`, constant init). Add
  `ctx.undefinedGlobalIdx?: number`. Add two emit helpers in `late-imports.ts`:
  `emitUndefinedSingleton(ctx, fctx)` (`global.get $undefined`) and
  `emitIsUndefinedSingleton(ctx, fctx)` (recover tag, `i32.eq 1` — or `ref.eq`
  against the singleton when the operand is already a `ref $AnyValue`). Nothing
  calls them yet. *Acceptance: existing standalone tests byte-identical; the global
  appears but is unreferenced.*
- **S1.1 — flip the producers + the undefined-specific consumers TOGETHER.**
  Standalone `emitUndefined` → `emitUndefinedSingleton`; `__extern_is_undefined`
  native impl → tag-1 check; the `=== undefined` / `typeof === "undefined"`
  consumers → `emitIsUndefinedSingleton`. These MUST land in one PR (a producer
  flip without the matching undefined-consumer flip, or vice-versa, is a
  half-state that regresses). *Acceptance: `undefined === undefined` true,
  `null === null` true, `null === undefined` FALSE, `typeof undefined` →
  "undefined" vs `typeof null` → "object" — all standalone, the issue's S1 test
  gate. PLUS the strict-eq cascade in `binary-ops.ts` now distinguishes them with
  NO `bothNullishGuard` collapse (this is where #1961's held guard becomes correct
  — re-key it on the singleton, not bare `ref.is_null`).*
- **S1.2 — sweep the nullish consumers (the ripple).** Route every `== null` /
  `?.` / `??` / default-fill / array-hole / SameValueZero-nullish site through the
  new `emitIsNullish` so they still catch the undefined singleton. This is the
  largest, most regression-prone stage — do it last, with a full `merge_group`
  baseline (value-rep broad-impact protocol — NEVER a scoped sweep, per
  `project_broad_impact_validate_full_ci`). *Acceptance: `undefined == null` true,
  `x ?? y` fires for undefined, `a?.b` short-circuits on undefined, destructuring
  default fires for undefined, no test262 regression.*

### #329 + funcIdx-authority cross-check (#1899)
S1 lands after #1899's funcIdx-authority contract (task #36, done) — verify the
`$undefined` global reservation composes with the finalize-shift accounting; the
global path avoids the func-shift entirely but confirm the global-index
accounting (`ctx.numImportGlobals + ctx.mod.globals.length`) is taken at
reservation time, not lazily.

### Why this is the real fix (and #1961 is held, not abandoned)
#1961's `bothNullishGuard` is correct in shape but, keyed on bare `ref.is_null`,
collapses null/undefined. Once S1.1 gives undefined distinct bits, that same guard
— re-keyed on `is_null(x) || is_undefined_singleton(x)` for the loose arm and the
plain tag check for strict — becomes exactly right. So #1961 stays open as the
diagnosis + repro harness and folds into S1.1/S1.2. The acceptance-criterion
"null vs undefined distinct standalone" is met ONLY by S1, not by #1961 alone.

## Suspended Work — S1.0 done + S1.1 WIP (sdev-async, 2026-06-23)

**Branch:** `issue-2106-s1-undefined-singleton`
**Worktree:** `/workspace/.claude/worktrees/issue-2106-s1-undefined-singleton`
**State:** tsc CLEAN. S1.0 (inert singleton reservation) is COMPLETE + validated.
S1.1 (flip producer + chokepoints) is WIP — 3/6 repro cases pass, 3 fail with
the precise causes diagnosed below. Resume from these failures.

### Landed (committed)
- **S1.0** (commit on branch): `$undefined` tag-1 global reserved at
  `ensureAnyValueType` (`any-helpers.ts`), `ctx.undefinedGlobalIdx`,
  `emitUndefinedSingleton` / `emitIsUndefinedSingleton` helpers. Inert, validated.
- **S1.1 WIP** (this checkpoint):
  - `emitUndefined` (`late-imports.ts`): standalone → `global.get $undefined` +
    `extern.convert_any` (was `ref.null.extern`).
  - `__extern_is_undefined` (`object-runtime.ts`): singleton-only (recover anyref,
    `ref.test $AnyValue`, tag==1); legacy `ref.is_null` fallback when no `$AnyValue`.
  - `__typeof_undefined` (`index.ts`): singleton-only (same tag-1 test).
  - strict-eq cascade (`binary-ops.ts`): the loose-only nullish guard is now
    applied to BOTH modes (`(lNull||rNull)?(lNull&&rNull):core`) — correct under S1
    because undefined is the non-null singleton.

### Repro status (`tests/issue-2106-standalone-nullish-strict-eq.test.ts`)
PASS: `null===null`, `nullish!==non-nullish`, `5===5`.
FAIL (3), with root causes:

1. **`undefined === undefined` → false (want true)** AND **`undefined !== undefined`
   → true (want false).** ROOT CAUSE: array/object literals push **raw
   `ref.null.extern`** for `undefined`-like values (`literals.ts:575/605/646/657/685`
   etc.), NOT `emitUndefined`. So `[undefined, undefined]` stores TWO NULLS, read
   back as null — but then `null===null`-via-the-guard should give true... it gives
   false, so the stored value is NOT plain null either (likely the S0 contextual-`any`
   boxing path tags the literal `undefined` as a tag-1 `$AnyValue` element via
   `boxToAny(jsStaticType=undefined)` — but `boxToAny`'s "undefined" case currently
   `break`s at `value-tags.ts:168`, so it falls to the Wasm-kind dispatch and boxes
   as... INVESTIGATE: dump the WAT of `[undefined,undefined]` element store).
   **NEXT:** make the literal-`undefined` producers (and `boxToAny`'s undefined arm)
   emit the singleton consistently so a stored `undefined` IS the singleton; then
   two reads `ref.eq` true. Either route literal undefined through `emitUndefined`,
   or implement `boxToAny`'s tag-1 arm to push the `$undefined` global.

2. **loose `null == undefined` → false (want true).** ROOT CAUSE: the loose nullish
   guard uses bare `ref.is_null`, which no longer catches the undefined singleton
   (non-null). **NEXT (the S1.2 ripple):** add `emitIsNullish(ctx,fctx)` =
   `is_null(x) || is_undefined_singleton(x)` and route the LOOSE `==`/`!=` nullish
   arm (binary-ops `looseNullish` guard) + `??` + `?.` + default-fill +
   array-hole + SameValueZero-nullish through it. ~42 `ref.is_null` sites to triage
   (nullish-intent → `emitIsNullish`; null-specific `=== null` → stays `ref.is_null`).

### Remaining work to finish S1 (atomic PR)
- Fix (1): consistent singleton production for ALL `undefined` producers
  (literals, `boxToAny` tag-1 arm, omitted-arg padding that uses raw
  `ref.null.extern` e.g. `calls.ts:1352/1700` thisArg — verify those are
  this-arg-only and not default-param relevant).
- Fix (2): `emitIsNullish` + the nullish-consumer sweep (S1.2).
- `typeof null` → "object": `__typeof_object` currently returns 0 for
  `ref.is_null`; flip null→"object" (return 1) so typeof null is correct (separate
  small follow-up, not strictly blocking the strict-eq fix).
- Validate via merge_group (value-rep broad-impact). Report net delta to
  sdev-coercion-impl / lead for the land decision. Supersede/close held PR #1961
  if S1 lands net-positive.

### Validation done so far
tsc clean; S1.0 inert validated (36 tests green: #1776/#1021/strict+loose
equality/#2106 S0/#2029). The 3 repro failures above are the WIP frontier.
