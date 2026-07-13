---
id: 3183
title: "standalone: any-typed array receiver — for-in enumerates ZERO keys and string-key reads answer undefined (dynamic-path vec arms missing in __object_keys_forin / __extern_has / __extern_get)"
status: done
assignee: ttraenkler/dev-vec-arms
completed: 2026-07-12
created: 2026-07-12
priority: high
feasibility: medium
task_type: bug
area: codegen
es_edition: multi
language_feature: for-in
goal: standalone
umbrella: 2860
sprint: 71
horizon: m
related: [3179, 3176, 3173, 3169, 2860]
origin: "Split out of #3179 during root-cause diagnosis (2026-07-12). #3179's PR fixed the illegal-cast trap face (emitArrayForIn); this issue is the remaining any-typed-receiver face."
# The dynamic for-in / string-key vec arms are new native-runtime codegen that
# belongs in object-runtime.ts (the dynamic-reader helpers it splices into all
# live there — fillExternGetIdxVecArms / fillExternArrayLikeStructArms /
# fillExternGetErrorProps are its siblings); the index.ts delta is just the
# import + one finalize call. Both are intended feature growth, not barrel bloat.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
# The vec arms REUSE the engine's existing coercion helpers — `number_toString`
# (canonical Number::toString for the enumerated index keys) and
# `__str_to_number` (§7.1.4.1 StringToNumber for the string index key) — they do
# NOT hand-roll a fresh ToString/ToNumber matrix. The gate counts the added call
# sites; this is intended reuse of the single engine, so grant the allowance.
coercion-sites-allow:
  - src/codegen/object-runtime.ts
---

# #3183 — standalone: dynamic-path helpers lack vec arms → any-typed arrays enumerate empty / read undefined

## Problem (verified repros, all on main)

When the receiver's STATIC type is `any` (so `resolveArrayInfo` fails and
for-in routes through the dynamic `$Object` path), a runtime ARRAY value
silently misbehaves in standalone:

```ts
// A: for-in yields ZERO iterations (expected 2)
export function test(): number {
  var arr: any = [5, 6];
  let n = 0;
  for (var k in arr) { n = n + 1; }
  return n; // ACTUAL 0, expected 2
}
```

Same for `var a: any = someTypedArrLocal` and `var arr: any = new Array(); arr[0]=…`.

```ts
// B: string-key element read on an any-typed vec answers undefined
// (the __extern_get route; dev-dataview's #3173 HOF face and dev-json's
// #3176 face both reduce to this when the receiver is statically any)
const anyArr: any = [7, 8, 9];
const k: any = "1";
anyArr[k]; // undefined instead of 8 when the read routes via __extern_get
```

## Root cause (pinned in the #3179 diagnosis)

A JS array in standalone lowers to a `__vec_<elemKind>` struct (subtype of
`$__vec_base`, #2186) — NOT a `$Object`. Vec-awareness was retrofitted into
the dynamic runtime piecemeal (`__extern_length` #2186, `__extern_get_idx`
#2190 finalize-fill, `__to_primitive` #2358, closed-struct trio #3169), but
THREE helpers on the for-in / string-key path still treat "not `$Object`" as
"no properties":

1. **`__object_keys_forin`** (`src/codegen/object-runtime.ts` ~line 3873):
   `ref.test $Object` fails → returns an EMPTY `$ObjVec` → the dynamic for-in
   loop in `compileForInStatement` (`src/codegen/statements/loops.ts` ~6162+)
   runs zero iterations. → face A.
2. **`__extern_has`** (~line 2329): non-`$Object` → 0. Even with keys fixed,
   the #2066 per-visit liveness guard (loops.ts ~6412-6427: `__extern_has(obj,
   key)`, skip body when 0) would then SKIP every iteration for a vec
   receiver. Both 1+2 are needed together.
3. **`__extern_get`** (~line 1030): non-`$Object` → undefined miss. `arr[k]`
   with a string/boxed key on a vec receiver answers undefined. → face B.

## Implementation Plan (mechanical — follow the existing patterns)

All three arms follow the established finalize-fill discipline (see
`fillExternGetIdxVecArms`, object-runtime.ts ~9965, and the #3169
closed-struct fill): **SPLICE arms into the existing body at FINALIZE — do
NOT rebuild the body** (rebuild re-bakes funcIdxs and desyncs the
late-import shift walk; that exact hazard regressed ~120 modules in #2190
round 2, see the comment at ~10040).

- **`__object_keys_forin` vec arm** (before the `$Object` test): if
  `ref.test $__vec_base` → loop `i = 0..len-1` (`len` = `struct.get` field 0
  through `$__vec_base`), push `number_toString(f64(i))` into the result
  `$ObjVec` via `__objvec_push`, return. This mirrors the key loop
  `emitArrayForIn` emits inline (loops.ts ~5907-5912). `number_toString` and
  `__objvec_push` are both registered before finalize in standalone.
  Note: vecs cannot carry expando properties, so index keys are EXACT.
- **`__extern_has` vec arm**: if `ref.test $__vec_base` → key `"length"` → 1;
  else `n = __str_to_number(key)` (§7.1.4.1, already exists —
  `emitNativeParseNumber` / `any-helpers.ts` ~857) → if `n == n` delegate
  `__extern_has_idx(v, n)` (already vec-aware via its finalize fill,
  object-runtime.ts ~4455/~10336) → else 0.
- **`__extern_get` vec arm**: if `ref.test $__vec_base` → key `"length"` →
  `__box_number(f64(len))`; else `n = __str_to_number(key)` → if `n == n`
  delegate `__extern_get_idx(v, n)` (vec-aware, handles OOB→undefined) →
  else undefined miss. (Strict CanonicalNumericIndexString would reject
  non-canonical keys like "00"; for-in-produced keys are canonical, so
  `__str_to_number` acceptance is a benign superset — note it in the arm
  comment.)

Ordering/registration: `__extern_get`/`__extern_has` are registered BEFORE
`number_toString`/`__extern_get_idx`/`__extern_has_idx`, so the arms MUST be
filled at finalize (add to the `fillExternGetIdxVecArms` call site in
`src/codegen/index.ts` ~2619, or a sibling fill function). Gate on
`ctx.standalone` (host mode's JS imports own these paths — keep host output
byte-identical).

## Acceptance criteria

- Repro A returns 2 (and the `new Array()`/aliased variants); keys are
  `"0".."n-1"` ascending.
- Repro B answers the element (8), `anyArr["length"]` answers 3.
- Zero host-lane regressions (host bodies byte-identical), zero standalone
  high-water regressions.
- Likely flips: #3176 residual rows, #3173 rows whose reads route via
  `__extern_get`, some #3169 HOF array-like rows.

## Test Results (#3179 baseline probes, 2026-07-12)

Pre-existing on main AND after #3179's fix (this issue's scope):
`.tmp/repro-3179-{h,l,m}.ts` → 0 iterations (expected 2/2/2).

## Resolution (2026-07-12)

Implemented as `fillDynamicForinVecArms` (`src/codegen/object-runtime.ts`),
wired into the finalize sequence in `src/codegen/index.ts` right after
`fillExternArrayLikeStructArms`. It PREPENDS a self-contained
`ref.test $__vec_base`-guarded arm into each of the three helpers (the
`fillExternGetErrorProps` splice discipline — append locals, never renumber;
falls through untouched on a non-vec receiver so host/non-vec output is
byte-identical). `__str_to_number` is emitted eagerly in the standalone block of
`ensureObjectRuntime` for a stable finalize funcIdx (measured to add 0 bytes —
it was already always emitted in standalone).

Deviation from the plan: the plan said `__extern_has_idx` was already
`$__vec_base`-aware — it was NOT (only `$ObjVec`/`$Object`). Rather than inline
the bounds in `__extern_has`'s arm (duplicating logic — anti-bloat), this PR
GENERALISES `__extern_has_idx` with a single guarded `$__vec_base` branch
(length read uniformly through the supertype, same `trunc_sat` bounds as
`__extern_get_idx`'s vec arm; the `$ObjVec` fast path is untouched since a vec
is not a `$ObjVec`). `__extern_has`'s numeric arm then delegates to it, so HAS
and GET stay in agreement and the #2066 liveness guard never skips a readable
index. The generalisation also fixes `__extern_has_idx` for any other caller
that passes a real array carrier.

Verified standalone (zero host imports, `tests/issue-3183.test.ts`, 11 cases):
- face A: `for (k in [5,6])` → 2; aliased `number[]` sum → 60; empty → 0.
- face B: `a["1"]` → 8, `a["2"]` → 9, `a["length"]` → 3.
- face C: for-in body `arr[k]` sum → 18.
- OOB / non-numeric / non-length key → undefined (→ 0). Plain-object for-in and
  string-key reads unchanged.

Size: +294 bytes for an array-using standalone module; 0 bytes for array-free.
`quality` cheap gates green locally: `check:issue-ids:against-main`,
`check:ir-fallbacks` (no bucket growth). For-in regression suite
(issue-2572-standalone-forin / issue-2964 / issue-forin / issue-2541) all green.

### Out of scope (follow-up): the WRITE path
`var a: any = new Array(); a[0] = 42; a["0"]` still reads 0 — the dynamic
STORE `__extern_set(a, idx, v)` is NOT `$__vec_base`-aware, so writes to an
any-typed vec do not land (and `new Array()` starts empty, so for-in over it
also yields nothing). This is a distinct write-path gap in `__extern_set`, not
one of the three READ helpers this issue scopes. READS of pre-populated vec data
(array literals, aliased typed arrays) all work.
