---
id: 2862
title: "Standalone: ToPrimitive throws 'Cannot convert object to primitive value' for built-in exotics + inherited valueOf/toString"
status: wont-fix
created: 2026-06-30
updated: 2026-06-30
priority: low
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: Backlog
horizon: l
related: [2860, 1900, 2358, 2638, 1910]
umbrella: 2860
architect_spec: candidate
---

# Standalone: ToPrimitive incomplete for built-in exotics + inherited methods

## Problem

In `--target standalone`, converting many objects to a primitive throws
`TypeError: Cannot convert object to primitive value` where js-host succeeds.

### Impact (measured 2026-06-30)

**2,039 standalone-only failures** carry this signature (the single largest
error signature in the gap). Of these, **728 are "pure"** (no host-import leak —
ToPrimitive is the sole blocker; the rest also leak a generator/promise/symbol
import and additionally need their carrier). By category among the 2,039:
Object 476, TypedArray 304, language/expressions 293, String 189, RegExp 125,
Array 88, DataView 43, Set/Map/Iterator/Function ~80.

Note: the proximate throw is often in **harness** code (`assert.sameValue`/
`String(x)` formatting a value), so flipping these also depends on the value's
own representation reaching a primitive.

## Root cause

The Wasm-native `__to_primitive` engine (`src/codegen/object-runtime.ts:2011`,
#1900/#2358/#2638) implements §7.1.1.1 OrdinaryToPrimitive over the standalone
runtime, with arms for:
- non-objects → unchanged
- `$__vec_base` (arrays) → `__array_to_primitive_string` (#2358)
- nominal class structs → `__class_to_primitive` valueOf/toString dispatch (#2638)
- `$Object` wrapper internal slot (`new Number/String/Boolean`) → slot value (#1910)
- `$Object` own-prop `valueOf`/`toString` via `__extern_get` + call, with a
  `"[object Object]"` default when `toString` is missing.

It falls to the `throwTypeError()` (object-runtime.ts:2278) when **none** match.
The misses are:

1. **Built-in exotic instances not modeled as `$Object`/`$Vec`/class-struct** —
   TypedArray views, DataView, ArrayBuffer, RegExp, boxed wrappers backed by a
   nominal runtime struct. These reach the non-`$Object` arm (line 2192), miss
   `ref.test $__vec_base` and `__class_to_primitive` (no user valueOf/toString
   dispatcher), and return **unchanged** → caller's `__unbox_number`/string
   coercion then fails, or a later ToPrimitive throws.
2. **`$Object` instances whose `valueOf`/`toString` are INHERITED** (on a
   prototype, not own) — `__extern_get(obj, "toString")` only reads OWN props in
   standalone (the prototype chain / `Object.prototype.toString` is not
   materialized), so both probes miss. For the **number/default** hint the
   `"[object Object]"` default is only supplied on the `toString` arm
   (`defaultObjectToStringOnMissing`), and `valueOf` missing returns nothing →
   falls through to throw.

## Implementation Plan

This is substrate-scale; **tagged `architect_spec: candidate`** — wants a design
pass on the value-representation classifier before coding. Sketch:

### A. Built-in exotic → primitive arm (object-runtime.ts ~line 2196, the
`!ref.test $Object` block)
- After the `$__vec_base` and `__class_to_primitive` arms, add a
  brand-dispatch over the built-in nominal structs (TypedArray view structs,
  DataView, RegExp, ArrayBuffer). Each has a spec'd OrdinaryToPrimitive result:
  - TypedArray / Array-like → `Array.prototype.toString` style join (reuse the
    `__array_to_primitive_string` reservation pattern, array-to-primitive.ts).
  - RegExp → `RegExp.prototype.toString` (`"/source/flags"`) — native string.
  - DataView/ArrayBuffer → inherit `Object.prototype.toString` → `"[object DataView]"`/`"[object ArrayBuffer]"`.
- Use the reserve-placeholder-funcIdx + fill-in-post-processing discipline
  (array-to-primitive.ts / class-to-primitive.ts) since these helpers depend on
  carriers registered AFTER `__to_primitive`.

### B. Default Object.prototype.toString for the number/default hint
(object-runtime.ts:2138 `tryOrdinaryMethod`)
- When BOTH `valueOf` and `toString` own-prop probes miss on a `$Object`, supply
  the `"[object Object]"` default on the **final** probe regardless of hint
  (today only the `toString`-arm default fires). Spec: a plain object with no own
  valueOf/toString uses `Object.prototype.{valueOf,toString}`; valueOf returns
  the object (not primitive) so toString wins → `"[object Object]"`. So: if both
  own probes miss, return `"[object Object]"` rather than throwing. The throw
  must remain reachable ONLY when a present `toString`/`valueOf` returns an
  object (the genuine §7.1.1.1 TypeError — keep the existing return-if-primitive
  guard so a present-but-object-returning method still throws).

### Edge cases / regression guards
- A user object with `Symbol.toPrimitive` must still take precedence (that path
  is handled before `__to_primitive` in the coercion engine — verify it isn't
  short-circuited by the new exotic arm).
- `new Number(5)` etc. wrapper slot (line 2240) must still win over the new
  default-toString arm (order preserved).
- Confirm the genuine §7.1.1.1 TypeError tests still throw:
  `test/.../Symbol.toPrimitive/*returns-object*`, ordinary toString/valueOf
  returning an object.

## Test plan

Standalone fail/CE → pass:
- `test/built-ins/TypedArray/prototype/**` (toLocaleString, join via ToPrimitive)
- `test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-*` (object formatting)
- `test/built-ins/Iterator/prototype/drop|take/**`
- `test/built-ins/RegExp/prototype/test/S15.10.6.3*`
- `test/language/expressions/**` ToPrimitive coercions

Validate full `merge_group` + standalone high-water. Expect the **728 pure**
to flip directly; re-measure the leak-bucket residual after #2864-#2867 land.
Zero host-mode regression (all arms `ctx.standalone`).

## Verify-first finding (2026-06-30, sendev) — root cause is mis-scoped; DO NOT code the substrate arms as-is

Verify-first against current main (`runTest262File(file, cat, undefined, "standalone")`,
the exact CI standalone path) shows the **proximate `"Cannot convert object to
primitive value"` throw is a JS-HOST TEST-RUNNER artifact, not the in-Wasm
`__to_primitive` engine.** The 728 "pure" tests are **heterogeneous** standalone
failures, all collapsed onto one signature by the runner's error-formatter.

### Mechanism (proven)
1. The standalone module compiles fine and `test()` throws a real
   `WebAssembly.Exception` at runtime (a genuine, per-test failure).
2. The runner's `extractWasmExceptionMessage` (`tests/test262-runner.ts:2913`,
   stack hits **line 2927**) extracts the payload via `err.getArg(tag, 0)` then
   calls **`String(payload)`**. The payload is a standalone Error object
   (Wasm-GC struct / `$Object`) with no JS-reachable `toString`, so the JS-host
   `String()` itself throws `TypeError: Cannot convert object to primitive
   value`. That host-side throw — NOT the in-Wasm engine — is what the baseline
   records (as `compile_error`/`fail` with this message).

### Evidence it is NOT the `__to_primitive` engine
- Direct standalone probes of the engine's suspected misses **do not throw**:
  `"" + new Uint8Array([1,2,3])` → `"1,2,3"` (works); plain `{}` → `"[object
  Object]"` (works); inherited `toString` → works; `new Number(5)*2` → 10
  (works). RegExp/DataView/ArrayBuffer concat return *wrong values* (0) but
  **do not throw** the TypeError.
- The sampled "ToPrimitive" failures test unrelated things:
  - `Object/getOwnPropertyDescriptor/15.2.3.3-2-14.js` → number→string **key
    coercion** (`ToString(+Infinity)`→`"Infinity"`); the in-Wasm throw is a
    null-deref on `desc.value` (lookup missed), nothing to do with object
    ToPrimitive.
  - `DataView/.../getInt8/toindex-byteoffset.js` → `ToIndex(byteOffset)`.
  - `TypedArray/prototype/fill/length.js` → `propertyHelper`/`verifyProperty`
    formatting.
  - `RegExp/prototype/global/this-val-regexp-prototype.js` → getter reflection
    (`Object.getOwnPropertyDescriptor(RegExp.prototype,'global').get.call(...)`).

### Recommended sequencing (supersedes the Implementation Plan sketch)
1. **De-mask first (triage-enablement):** make `extractWasmExceptionMessage`
   (and the CI worker `scripts/compiler-fork-worker.mjs`, if it shares the path)
   never throw while stringifying a Wasm-GC payload — wrap `String(payload)` in
   try/catch and/or read the error struct's message field defensively, falling
   back to a generic class label. **Error-text only — flips zero pass/fail**, so
   the standalone-floor (pass count) and the regression gate (pass→fail
   transitions) are unaffected; it only relabels the ~2014 entries onto their
   REAL signatures so the cluster can be triaged.
2. **Re-triage** the now-visible signatures into real clusters (number→string
   key coercion, `ToIndex` object coercion, getter reflection, propertyHelper
   formatting, …) and file/route those as separate issues.
3. The genuine `__to_primitive` arms A/B in the plan above ARE real spec gaps
   but address only a subset (e.g. RegExp/DataView concat returning the wrong
   value) — they must NOT be sold as flipping all 728.

**Status set to `blocked`** pending the architect design pass this issue is
already tagged for (`architect_spec: candidate`). The claim is released so the
de-mask step (a test-infra change, not this compiler substrate) can be routed
independently.

## Implementation Plan (architect design pass, 2026-06-30)

This design pass **honors the verify-first finding above** and supersedes the
A/B sketch in the original "Implementation Plan". The headline correction: the
proximate `"Cannot convert object to primitive value"` signature is *mostly* a
test-runner stringify artifact, NOT one compiler bug. So #2862 is **not one
substrate change** — it is (0) a test-infra de-mask, then (1) a genuinely
bounded value-rep substrate change for built-in exotics reaching a primitive,
which the operator paths (`==`/`+`/relational) already call into. **#2862 must
be SPLIT.**

### The value-rep substrate, as it actually stands (read against current main)

The standalone `any` value representation is the `$AnyValue` struct
(`ensureAnyValueType`, any-helpers.ts:23): fields `tag:i32, i32val, f64val,
refval:eqref, externval:externref`. Tags: `0=null 1=undefined 2=i32 3=f64
4=bool 5=string/boxed 7=function`; `tag>=5 ⇒ truthy object`. The "tag-5 field-4
3-way classifier" (`tag5StringEqThen`/`tag5ToNumber`, any-helpers.ts:685/1138)
discriminates *within* tag-5 between an `$AnyString` ref and a boxed-number
carrier using `externval` (field 4) + `ref.test $AnyString` — that classifier is
**equality/ToNumber-local and must NOT be widened blindly** (the #2040 note in
any-helpers.ts:1677-1686 explicitly DROPS extra tag-5 classifier arms because
changing the boxed-value shape regressed dstr defaults — `reference_2040`,
`project_2040_tag5_classifier_dstr_default_regression`). **Do not route the
exotic-to-primitive fix through the tag-5 classifier.** The correct seam is
`__to_primitive` (object-runtime.ts:2194), which the operators already call.

### Operators already call `__to_primitive` — the gap is its COVERAGE, not the wiring

- Loose `==`/`!=` (binary-ops.ts:2310-2329): when exactly one operand is an
  object (`typeofObject` XOR), it overwrites the operand in place with
  `__to_primitive(operand, default)`. **Wired.**
- Binary `+` and relational (binary-ops.ts:2034): a struct-ref operand is
  coerced to f64 via `coerceType(..., hint)` which bottoms out in
  `__to_primitive`. **Wired.**

So the substrate change is entirely *inside* `__to_primitive`'s arm cascade
(object-runtime.ts:2361-2462). Today it handles: non-object (unchanged) ·
`$__vec_base` array → `__array_to_primitive_string` · nominal class struct →
`__class_to_primitive` · `$Object` wrapper internal slot · `$Object` own
`valueOf`/`toString` with a `"[object Object]"` default. It **falls through to
`return unchanged`** (object-runtime.ts:2408-2413, NOT a throw) for a built-in
exotic that is none of those — a TypedArray view, DataView, ArrayBuffer, RegExp,
or boxed wrapper backed by a nominal runtime struct. "Return unchanged" then
makes the caller's `__unbox_number`/string coercion produce the WRONG value
(0/NaN) — it does **not** itself throw the headline TypeError (the verify-first
probes confirmed: `"" + new Uint8Array([1,2,3])` already works via the
`$__vec_base` arm; `"" + /x/` returns the wrong value but does not throw).

### Changes — bounded, all in the `!ref.test $Object` block (object-runtime.ts ~2378)

Add a brand-dispatch BETWEEN the existing `$__vec_base` arm (2384) and the
`__class_to_primitive` arm (2399), reducing each built-in exotic to its spec
OrdinaryToPrimitive result. Each reuses the **reserve-placeholder-funcIdx +
fill-in-post-processing** discipline (the established
`reserveArrayToPrimitiveString` / `reserveClassToPrimitive` /
`fillClassToPrimitive` pattern, class-to-primitive.ts:58/111) because these
helpers depend on carriers/structs registered AFTER `__to_primitive`:

1. **RegExp exotic** → `RegExp.prototype.toString` = `"/" + source + "/" + flags`.
   The `$NativeRegExp` struct is recoverable via the existing
   `recoverRegExpStructFromExternref` (regexp-standalone.ts:908) and the field
   reads already exist (`emitRegExpReflectionFieldRead`). Arm: after the
   `$__vec_base` test, `ref.test` the standalone RegExp struct
   (`ensureStandaloneRegExpStruct`) → if hit, build the source/flags string and
   `return`. (This is the only exotic with a non-`[object X]` ToPrimitive.)
2. **TypedArray view** → `%TypedArray%.prototype.join(",")` (Array-like
   toString). **This arm DEPENDS ON #2893's `recoverTypedArrayViewFromExternref`
   classifier** — without a view brand the engine cannot tell a view from a
   `number[]` here either (the integer views are already type-distinct so
   `ref.test $__vec_i8_byte`/… classifies them; the float views need #2893 PR-2).
   So gate this arm behind #2893 and reuse its classifier. NOTE: integer-view
   concat *already* works via the `$__vec_base` arm (a view IS a `$__vec_base`
   subtype) → so this arm is only needed for the float-view + correct-formatting
   subset; verify-first to confirm it is even a gap before coding.
3. **DataView / ArrayBuffer** → inherit `Object.prototype.toString` →
   `"[object DataView]"` / `"[object ArrayBuffer]"` native string constants.
   These are `__vec_i32_byte` structs (new-super.ts:4484) — `ref.test
   $__vec_i32_byte` distinguishes them, but that key is SHARED by both
   ArrayBuffer and DataView (and SharedArrayBuffer), so the exact `[object X]`
   label cannot be recovered from the vec type alone. **This is a real
   sub-blocker** — either accept a generic `"[object Object]"` for these (spec
   wants the specific tag, but a generic label flips the no-throw subset), or
   defer DataView/ArrayBuffer ToPrimitive to a follow-up that gives them a brand
   (parallels #2893). Recommend: ship the generic-label arm first (unblocks the
   no-throw rows), file the specific-tag refinement separately.

For the §7.1.1.1 step-6 "must return primitive" TypeError, keep the existing
`returnIfPrimitive` guard (object-runtime.ts:2256) so a present-but-object-
returning `valueOf`/`toString` STILL throws (the genuine-TypeError tests).

### Default `Object.prototype.toString` for inherited-method misses (object-runtime.ts:2321 `tryOrdinaryMethod`)

Today the `"[object Object]"` default fires only on the `toString`-arm when the
own probe misses (`defaultObjectToStringOnMissing`). Per §7.1.1.1 a plain object
with neither own `valueOf` nor own `toString` resolves to
`Object.prototype.toString` → `"[object Object]"`. When BOTH own probes miss
(standalone `__extern_get` is OWN-only; the prototype chain is not materialized),
return `"[object Object]"` rather than falling through to `throwTypeError`. Guard:
this default must NOT mask the genuine TypeError when a present method returns an
object — keep the `returnIfPrimitive` guard on present methods.

### Late-funcIdx discipline (has bitten before — `reference_1461`/`reference_2191`/`reference_2193`)

- The new exotic arms call helpers (`__array_to_primitive_string`, the RegExp
  source/flags builders, string-constant globals) that are registered AFTER
  `__to_primitive`. **Reserve a stable placeholder funcIdx at `__to_primitive`
  build time and FILL the body post-processing** — never read the helper's
  funcIdx inline (it does not exist yet). Mirror `reserveArrayToPrimitiveString`
  (object-runtime.ts:2223) exactly.
- `addUnionImportsViaRegistry` is already called at the top of the
  `__to_primitive` block (object-runtime.ts:2208) — keep any new `ensureLateImport`
  BEFORE the funcIdx reads, and if a late import is added inside the body, flush
  with the established shift discipline so the in-progress body's call targets
  don't desync (the #1890/#329 finalization-shift class that corrupted strict
  `===`, binary-ops.ts:2249).
- The fill helpers must run in the correct post-processing ORDER relative to
  `emitToPrimitiveMethodExports` / `fillClassToPrimitive` (object-runtime.ts
  finalize) — add the new fills alongside them, after the carrier structs exist.

### Edge cases / regression guards

- `Symbol.toPrimitive` precedence: a user `@@toPrimitive` is handled in the
  coercion engine BEFORE `__to_primitive` — verify the new exotic arms don't
  short-circuit it (they run only in the `!ref.test $Object` block, which a
  `$Object` with `@@toPrimitive` never reaches). The
  `structHasStaticNumericToPrimitive` fast-path (binary-ops.ts:3188) must still
  win for nominal structs with a static numeric ToPrimitive.
- `new Number(5)` etc. wrapper-slot arm (object-runtime.ts:2423) must keep
  winning over the new default-toString arm — it runs in the `$Object` block,
  before the cascade reaches the exotic arms. Order preserved.
- Genuine `§7.1.1.1` TypeError tests MUST still throw: `Symbol.toPrimitive`
  returning an object, ordinary `toString`/`valueOf` returning an object. Keep
  the `returnIfPrimitive` guard + the trailing `throwTypeError()`.
- All new arms `ctx.standalone`-gated (the host lane uses `_hostToPrimitive`).

### Verify-first plan (run BEFORE coding — the verify-first finding is mandatory)

0. **PREREQUISITE (route as a SEPARATE test-infra task, NOT this issue):** the
   de-mask of `extractWasmExceptionMessage` (test262-runner.ts:2913/2927) +
   `scripts/compiler-fork-worker.mjs` — wrap `String(payload)` in try/catch.
   **Error-text only, flips zero pass/fail.** Until this lands, the ~2014
   mis-labeled rows cannot be re-triaged and the true #2862 cluster size is
   unknown. Do not start the compiler work until the de-mask reveals the real
   per-exotic counts.
1. Probe each exotic on current main via the EXACT CI standalone path
   (`runTest262File(file, cat, undefined, "standalone")`): `"" + /x/`,
   `"" + new DataView(new ArrayBuffer(8))`, `\`${new Float64Array([1])}\``,
   `1 + {}` (inherited toString). Record actual vs spec. Only code the arms that
   are a REAL gap (the integer-view concat is already correct — do not re-add it).
2. After coding, re-run the relevant `language/expressions/**` operator dirs
   (`addition`, `equals`, relational) + `built-ins/RegExp/prototype/Symbol.*` +
   the genuine-TypeError tests. Confirm fail→pass on the targeted exotics AND no
   pass→fail on the genuine-TypeError set.
3. Full `merge_group` + standalone high-water; 0 host-mode regression.

### Files

- `src/codegen/object-runtime.ts` — `__to_primitive` arm cascade (the
  `!ref.test $Object` block, 2378-2413) + `tryOrdinaryMethod` default (2321) +
  the new reserve/fill placeholders alongside `reserveArrayToPrimitiveString`.
- `src/codegen/regexp-standalone.ts` — read-only reuse of
  `recoverRegExpStructFromExternref` / `emitRegExpReflectionFieldRead`.
- `src/codegen/array-to-primitive.ts`, `src/codegen/class-to-primitive.ts` —
  reserve/fill template (read-only reference).
- `tests/test262-runner.ts` + `scripts/compiler-fork-worker.mjs` — the de-mask
  (SEPARATE task, step 0).

### Estimated cluster size + split verdict

The original "728 pure" figure is **not** the deliverable of this substrate
change (verify-first proved it heterogeneous). Realistic per-arm yields after
de-mask: RegExp ToPrimitive ~20-40 (`RegExp` 125 total, only the
concat/format subset); built-in-exotic concat/format across DataView/
ArrayBuffer/float-TypedArray ~30-60; inherited-default `[object Object]` for
plain objects ~30-80. **Total realistic ~80-180 standalone rows** — materially
smaller than 728, with the remainder belonging to the re-triaged real clusters
(number→string key coercion, `ToIndex` object coercion, getter reflection,
propertyHelper formatting) that the de-mask exposes as SEPARATE issues.

**SPLIT VERDICT: #2862 is bigger than one focused effort — split into:**
- **#2862-A (test-infra, do FIRST, unblocks triage):** the runner de-mask
  (step 0). Flips zero tests but is the prerequisite for sizing everything else.
- **#2862-B (this substrate change):** the `__to_primitive` exotic arms +
  inherited-default. The TypedArray-view arm DEPENDS ON #2893 (shared brand
  classifier) — sequence after #2893 PR-1, or scope #2862-B to RegExp + DataView/
  ArrayBuffer generic-label + inherited-default and leave the float-view arm to
  ride #2893.
- **#2862-C..n (re-triaged clusters):** filed from the de-mask output (number→
  string key coercion, ToIndex, getter reflection, propertyHelper) — NOT this
  issue.

Dispatch #2862-A immediately (independent, low-risk). Hold #2862-B until the
de-mask reveals real counts AND #2893 PR-1 lands (for the view arm). Do NOT sell
#2862-B as flipping the 728.

## Re-measurement on current main, 2026-06-30 (sendev-toprim) — WONT-FIX

Re-measured the whole issue empirically against current `origin/main`
(`bd5ae6f3f`) per the "measure before building" mandate. Verdict: **#2862-A is
already delivered and #2862-B is a net-≈0 change against the standalone test262
floor.** Setting `status: wont-fix`, `sprint: Backlog`. The narrow real gap that
remains is recorded below for whoever needs it, but it does not earn a sprint
slot.

### Finding 1 — #2862-A (the de-mask) is MERGED. Do NOT rebuild it.

The runner de-mask the architect pass made a prerequisite was filed and landed
as **#2870** (merged PR #2346, commit `4fdb36d63` / `9e411f74c`). `String(payload)`
is now wrapped by `safeStringifyThrown` in **both** consumers:
- `tests/test262-runner.ts:2955` (`safeStringifyThrown`, used at
  `extractWasmExceptionMessage:2966`), and
- `scripts/test262-worker.mjs:881` (the CI sharded-worker path).
On a non-stringifiable Wasm-GC payload they now return
`"uncaught Wasm-GC exception (non-stringifiable payload)"`, and
`scripts/build-test262-report.mjs:717-724` buckets that label. So the
phantom-TypeError mask is gone; the ~2014 rows are already re-triageable. Any
new #2862-A work would be net-zero.

### Finding 2 — #2862-B (exotic→primitive arms) flips ~0 standalone test262 rows.

Probed the actual `__to_primitive` behaviour and ran the cited paths through the
EXACT CI standalone path (`runTest262File(file, cat, undefined, "standalone")`):

- **Explicit coercion already works.** `(/abc/g).toString()` → `"/abc/g"` (len 6,
  `=== "/abc/g"` is true). `String(/abc/g)` → `"/abc/g"` (correct). Both the
  `.toString()` method dispatch and the `String()` builtin already reach the
  right primitive.
- **Only IMPLICIT `+`-concat of an exotic with an INHERITED toString is wrong**,
  and it does NOT throw — it returns `"[object Object]"`: `"" + /abc/g` → 15-char
  `"[object Object]"` (should be `/abc/g`); `"" + new DataView(buf)` and
  `"" + new ArrayBuffer(8)` → `"[object Object]"` (should be the specific
  `[object DataView]`/`[object ArrayBuffer]` tag). So these ARE `$Object`-shaped
  and hit the existing `"[object Object]"` default — a wrong-tag, not a throw.
- **test262 does not exercise that implicit-concat path as a failure cause.** The
  most arm-B-relevant directory, `built-ins/RegExp/prototype/toString/`, is 8/9
  fail — but for unrelated reasons: 4 are Wasm **compile_errors** (codegen
  validation bugs, not ToPrimitive), and the rest are `.prototype`-reflection /
  `isConstructor` / "not-a-constructor" tests (`S15.10.6.4_A6/A7`,
  `called-as-function`, `not-a-constructor`). `RegExp/Symbol.replace/coerce-global`
  fails on `defineProperty`/`Symbol.replace` semantics. `Object/getOwnProperty
  Descriptor/15.2.3.3-2-14` fails on a null-deref (key coercion), surfacing now
  as the de-masked non-stringifiable label. NONE are flipped by a RegExp/DataView/
  ArrayBuffer ToPrimitive arm.

This confirms the verify-first finding above with current-main numbers: the
"728/2039 ToPrimitive" cluster is heterogeneous and its members fail on
unrelated mechanisms. Building the arm-B substrate would correct a genuine but
**unobserved-by-test262** spec detail (implicit-concat tag of an exotic) → net
≈0 on the standalone floor, i.e. exactly the change this role is told not to
build / self-merge.

### Residual (recorded, not scheduled)

- The implicit-concat exotic-tag gap (RegExp `/src/flags`, `[object DataView]`,
  etc.) is real but yields ~0 test262 and is **gated on the same brand
  classifiers** (#2893 for the view/buffer brand) the architect pass flagged.
  Revisit only if a future cluster actually depends on it.
- The TypedArray-view `test()` **compile_error** seen while probing
  (`call[0] expected type (ref null 6), found local.tee of type i32` when
  compiling `"" + new Uint8Array([1,2,3])` inside a `test()` wrapper) is a
  SEPARATE codegen-validation bug, not ToPrimitive — worth its own issue if it
  recurs in the de-masked triage.

**Net result of this pass: 0 code changes (documentation/disposition only).**
The de-mask is shipped; the substrate arms are net-zero; the issue is closed
`wont-fix` and parked to Backlog.
