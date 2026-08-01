---
id: 2742
title: "String.prototype methods: ToString(this) generic-receiver coercion, RequireObjectCoercible, and function `.length` own property"
status: ready
sprint: current
created: 2026-06-27
updated: 2026-08-01
assignee: ttraenkler/s78-dev2
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
es_edition: ES5
language_feature: string-methods
goal: es5
related: [2670]
depends_on: []
# (#3102 ratchet) Accessor-return marshalling belongs beside its sibling
# host-value bridges and closure caches in runtime.ts. The merge-group
# regression repair also needs source rest-parameter metadata and one narrow
# emitted classifier: the generic host dispatcher cannot materialize a rest vec,
# so the runtime must classify that source shape before exposing the closure.
# PR #3753 keeps lastIndexOf's method-specific NaN fallback beside the shared
# native-string integer-argument lowering.
# (#2742 s78-dev2) The standalone arm of this issue lands in the reflective
# String proto member-body dispatcher: the superseded #2875 wiring that
# intercepts ahead of #3254's corrected borrowed-receiver path lives in
# array-object-proto.ts, and the transferred-shape arms it composes with live
# in char-at-transfer.ts / vec-props.ts / native-proto.ts.
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/char-at-transfer.ts
  - src/codegen/native-proto.ts
  - src/codegen/vec-props.ts
  - src/runtime.ts
  - src/codegen/closure-exports.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/string-ops.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
---
# #2742 — String.prototype generic-receiver `ToString(this)` coercion

Every `String.prototype` method begins with `RequireObjectCoercible(this)` then
`ToString(this)` — it must work when `this` is **not** a primitive string
(a `Number`/`Boolean`/`Array`/plain-`Object` wrapper, or `null`/`undefined`).
Our implementations assume a string receiver, so the large
`built-ins/String/prototype/*` cluster fails on the generic-receiver path. This
mirrors #2670 (Array generic array-like receiver) but for String, and is a
single clean root cause spanning ~50 tests.

## Failing patterns / test262 files (current main)

**(a) Non-string `this` must be `ToString`-coerced** (e.g.
`__instance = new Object(42); __instance.charAt = String.prototype.charAt;
__instance.charAt(0)`):
- `test/built-ins/String/prototype/charAt/S15.5.4.4_A1_T1.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A1_T1.js`
- `test/built-ins/String/prototype/indexOf/S15.5.4.7_A1_T1.js`
- `test/built-ins/String/prototype/lastIndexOf/S15.5.4.8_A1_T1.js`
- `test/built-ins/String/prototype/slice/S15.5.4.13_A1_T1.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A3_T1.js`,
  `…/S15.5.4.15_A3_T2.js`, `…/S15.5.4.15_A3_T4.js`
- `test/built-ins/String/prototype/concat/S15.5.4.6_A1_T10.js`

**(b) `null`/`undefined` `this` must throw a real `TypeError`
(`RequireObjectCoercible`), not an internal null-deref:**
- `test/built-ins/String/prototype/charAt/S15.5.4.4_A2.js`,
  `…/charAt/S15.5.4.4_A1.1.js`, `…/charAt/S15.5.4.4_A5.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A2.js`,
  `…/charCodeAt/S15.5.4.5_A4.js`
- `test/built-ins/String/prototype/slice/S15.5.4.13_A3_T4.js`,
  `…/slice/S15.5.4.13_A1_T5.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A3_T7.js`,
  `…/substring/S15.5.4.15_A3_T10.js`

**(c) `this` whose `valueOf`/`toString` must run through `ToPrimitive`/`ToString`
ordering (trim family):**
- `test/built-ins/String/prototype/trimStart/this-value-object-tostring-meth-priority.js`
- `test/built-ins/String/prototype/trimEnd/this-value-object-toprimitive-meth-priority.js`
- `test/built-ins/String/prototype/trimStart/this-value-object-valueof-meth-priority.js`
  (currently `Cannot convert object to primitive value` runtime traps)

**(d) Each `String.prototype.X` must expose a `length` own data property
(function arity):**
- `test/built-ins/String/prototype/charAt/S15.5.4.4_A8.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A8.js`
- `test/built-ins/String/prototype/indexOf/S15.5.4.7_A8.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A8.js`

## Acceptance criteria

- Group (a): a `String.prototype` method invoked with a non-string `this`
  (`new Number(n)`, `new Boolean(b)`, `new Array(...)`, plain object) coerces via
  `ToString(this)` and returns the spec result. ≥8 of the listed (a) files pass.
- Group (b): `null`/`undefined` `this` throws `TypeError`; ≥7 of the listed (b)
  files pass (no `dereferencing a null pointer` / `Cannot access property` trap).
- Group (c): the trim-family `this`-ToPrimitive ordering tests stop trapping;
  ≥2 of 3 pass.
- Group (d): `String.prototype.{charAt,charCodeAt,indexOf,substring}.hasOwnProperty('length')`
  is `true`; all 4 listed (d) files pass.
- **Target: ≥40 of the ~66 ES3-core `String.prototype` generic-receiver tests
  fixed.** No regression in currently-green String tests.

## Implementation notes

**Group (d) fixed** (PR #2742-d carve-out, 2026-06-27): The test runner was
incorrectly transforming `obj.propertyIsEnumerable(key)` → `obj.hasOwnProperty(key)`
globally, which masked the non-enumerable nature of builtin function `.length`.
The codegen (`compilePropertyIntrospection`) already correctly emits
`__propertyIsEnumerable` for `externref` receivers (native functions), which
delegates to `Object.prototype.propertyIsEnumerable.call(obj, key)` in the
runtime — returning `false` for the non-enumerable `.length` own property. Fix:
removed the two blanket `propertyIsEnumerable→hasOwnProperty` transforms from
`wrapTest()` in `tests/test262-runner.ts`. All 4 group-(d) test262 files now pass;
no regressions in currently-passing tests.

**Groups (a)/(b)/(c) remain open** — substrate-gated (generic-receiver
`ToString(this)` coercion). Tracked in this issue; assigned separately.

## Scope / out of scope
- IN: charAt, charCodeAt, indexOf, lastIndexOf, slice, substring, concat,
  trim/trimStart/trimEnd generic-receiver + `ToString(this)` + `.length`.
- OUT: regex-driven methods (`match`/`matchAll`/`replace`/`replaceAll`/`split`/
  `search`) — those depend on the RegExp engine residual (#2161); `localeCompare`
  / `normalize` / Unicode case-folding (toLowerCase/toUpperCase locale) — separate
  Unicode-substrate slice; BigInt-argument coercion tests (blocked).
- Spec: ES2023 §22.1.3 String.prototype methods; `RequireObjectCoercible` §7.2.1,
  `ToString` §7.1.17.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — group carve-out. Group (d) (builtin function .length non-enumerable + a test-runner fix) landed. The headline ToString(this) generic-receiver coercion for String.prototype methods (charAt/charCodeAt/indexOf/slice/substring/concat...) + remaining groups remain. Stays in-progress.

## Measurement re-grounding (2026-07-26, opus-loop-d) — the group framing above is WRONG

Before writing code I re-ran the **exact 22 files this issue lists** through
`runTest262File` on `main` @ `e16edd48a`, with a positive control (a String test
expected to pass) and a negative control (a deliberately-wrong expectation) to
prove the harness can report both outcomes. **Baseline: 10 pass / 12 fail.**
Three of this issue's claims do not survive contact with the measurement.

> ⚠️ **LANE CORRECTION (s78-dev2, 2026-08-01): everything in the section below
> was measured on the DEFAULT (JS-host) lane ONLY.** `runTest262File` defaults
> to the host target unless `"standalone"` is passed as its 4th argument. On
> `--target standalone` these same group-(a) shapes still FAIL. So "group (a) is
> essentially ALREADY FIXED" is true of one lane and false of the other, and
> reading it unqualified is how this issue looked done while 157 ≤ES5
> `String/prototype` files were failing standalone-only. Measured 2-lane numbers
> are in "Two-lane decomposition" below. **Do not quote a claim from this
> section without naming the lane it was measured on.**

**1. Group (a) is essentially ALREADY FIXED — 8 of its 9 listed files pass on
`main` today.** `charAt`/`charCodeAt`/`indexOf`/`lastIndexOf`/`slice` +
3× `substring` with a non-string `this` all pass. Only `concat/S15.5.4.6_A1_T10`
fails, and for an unrelated reason (an *argument*'s `toString`, not the
receiver's). The issue's headline — "our implementations assume a string
receiver" — is stale.

**2. Group (b) is MISLABELLED.** It is described as `RequireObjectCoercible`
(null/undefined `this`). It is not: genuine `String.prototype.charAt.call(undefined)`
already throws a proper `TypeError` on `main` (probed directly). The 8 failing
(b) files are two *different* mechanisms:

- **6 files — "X is not a function".** Shape is
  `__FACTORY.prototype.charAt = String.prototype.charAt; new __FACTORY().charAt(…)`.
  **This is NOT String-specific.** The decisive control: assigning a *plain user
  function* to a user constructor's prototype (`F.prototype.m = function(){…}`)
  and calling it fails **identically** (`m is not a function`). The real defect is
  **dynamic `F.prototype.X = …` augmentation followed by an instance call** — a
  separate, broader issue that should not be filed under String.
  Note `charAt/S15.5.4.4_A1.1` additionally uses `eval("1")`, so it is
  `runtime-eval`-gated regardless.
- **2 files — `charAt/S15.5.4.4_A5`, `charCodeAt/S15.5.4.5_A4`** ("dereferencing
  a null pointer"). These belong with group (c): the receiver's own
  `toString`/`valueOf` must run and propagate a user throw.

⚠️ **This also corrects the #3626 census's C1 `missing_builtin` classification.**
The census reads the "`X` is not a function" signature (58 corpus-wide) as
*"genuinely missing methods — add/repair the method"*. Measured here, the methods
are **present and correct**; the failure is prototype-chain augmentation. Sizing
any work off "add the missing method" would be sizing off a mislabel.

**3. Group (c) is the one real in-scope defect — root-caused and fixed below.**

## What landed in this slice (group (c) root cause)

Traced through the host-marshalling boundary with the argument actually handed to
V8's native `String.prototype.trim`:

```
arg0: rawIsWasmStruct=false  toStringType=undefined  valueOfType=object
      descs=toString:getter,valueOf:getter   valueOfIsWasmStruct=true
```

`get valueOf() { return function () { … }; }` lowers the inner function to a
**WasmGC closure struct**. The getter itself was already bridged (V8 can invoke
it), but its **return value crossed back raw**, so V8 saw
`typeof o.valueOf === "object"` — not callable. In `OrdinaryToPrimitive`
(§7.1.1.1 step 5.b `IsCallable(method)`) a non-callable method is silently
**skipped**; with `toString` also non-callable the algorithm reaches step 6 and
throws `"Cannot convert object to primitive value"`.

**Fix** (`src/runtime.ts`): `_wrapAccessorGetterReturn` marshals an accessor
getter's return through `_maybeWrapCallableUnknownArity`, which converts only
values `__is_closure` positively identifies and passes everything else through.
Deliberately confined to the **accessor** path — marshalling *generic* call exits
was tried and reverted for regressing ~85 dstr files (#3123/#2835), which is also
why `wasmClosureDynamicBridge` carves out the `new`-path only.

Post-fix, the receiver now matches V8 exactly on the encoded probe
(`toStringAccessed=1, valueOfAccessed=1`, `trim` → `"xy"`; V8 = 111).

## Honest result — gross fixed and regressions, separately

- **Regressions: 0** (22-file set re-run; equivalence suite green).
- **test262 files flipped by this slice: 0 of 22.** The pass count is 10 → 10.
  The 3 group-(c) files move *past* the spurious `TypeError` to a deeper
  assertion, but do not flip.
- **New coverage: 3 tests red on the merge base**, green with the fix
  (`tests/issue-2742.test.ts`, group (c) block), plus 2 narrowness/no-regression
  guards green on both.

This slice removes a real spec violation and a whole spurious-`TypeError` class;
it does **not** claim conformance flips it cannot demonstrate.

## Remaining blockers (measured, not guessed)

1. **`@@toPrimitive` on the receiver is never consulted.** With a
   `get [Symbol.toPrimitive]()` present, the encoded probe returns `0` accesses
   where V8 gives `1` (`toString`/`valueOf` are now correct at 1/1). This is what
   still blocks all 3 group-(c) test262 files — they assert the *access counters*,
   not just the value. Symbol-keyed accessors are not reaching the host
   ToPrimitive path.
2. **Dynamic `F.prototype.X = …` then instance call** (the 6 "not a function"
   files) — broader than String; needs its own issue.
3. **`concat/S15.5.4.6_A1_T10`** — argument-side `toString`, unrelated to the
   receiver.

Stays `in-progress`: this closes the group-(c) root cause, not the issue.

## Merge-group regression remediation (PR #3660, 2026-07-26)

The bot-held merge-group run `30187000346` tested immutable merge commit
`ff373100552e1d6c4f9c792a8eecf6e01fadbd23`. Recomputing the gate from its
downloaded candidate artifact against exact selected baseline
`100c90d3b71426b6ec2cf6a6e920878325ac1a02` found 33 stable regressions after
flakiness/quarantine filtering, 42 fine-gate improvements, and signature
`fc7292a8a6f761c1`. The trap ratchet also isolated one new
`illegal_cast`: `test/built-ins/Object/keys/proxy-keys.js`.

There were two causal defects:

1. The first implementation wrapped the already-cached getter bridge in a
   second JavaScript function. Accessor getter identity is observable, so
   `Object.getOwnPropertyDescriptor(o, "x").get === getter` became false and a
   SameValue redefinition of a non-configurable accessor incorrectly threw.
   The repair marks bridge-owned getter functions and marshals the return inside
   that same bridge. No new function replaces the descriptor getter.
2. `proxy-keys.js` returns a source rest closure from an accessor. Rest lowering
   gives that closure one concrete Wasm vec formal, but a native `Proxy` call
   supplies positional host arguments. Sending the first host argument through
   the generic dynamic dispatcher therefore trapped in a concrete `ref.cast`.
   `ClosureInfo` now records the source rest shape and the module emits a narrow
   `__closure_has_rest` discriminator. The accessor bridge leaves such closures
   raw, preserving current-main's accepted `missing_builtin` limitation instead
   of worsening it to an uncatchable Wasm trap. Ordinary zero- and nonzero-arity
   returned functions are still bridged.

No-capture closures reuse a signature-keyed wrapper type. A non-rest closure
with the exact same concrete vec signature is therefore conservatively left raw
too; captured closures retain distinct subtypes. This bounded tradeoff avoids an
ABI change to closure structs in a regression-only repair.

This deliberately does not catch and retry a trapped dynamic call, alter any
Test262 baseline, or broaden generic call-exit marshalling (the latter already
regressed ~85 dstr files in #3123/#2835).

Validation after merging current `main` (`f7d1187fa2c79e0153731308200ebb2c6cac274b`):

- `tests/issue-2742.test.ts`: 15/15 pass, including getter identity,
  non-configurable SameValue redefinition, an arity-1 returned setter, and the
  rest-closure trap guard.
- Exact immutable affected set: 75/75 Vitest cases pass — all 33 stable
  regressions and all 42 fine-gate improvements.
- Exact controls: the three dominant identity regressions pass;
  `proxy-keys.js` reports `missing_builtin` (“not a function”), with no
  `illegal_cast`.

## `lastIndexOf` NaN-position residual (PR #3753, 2026-07-28)

Standalone lowering now preserves `lastIndexOf`'s from-end sentinel when a
position expression coerces to `NaN` or `undefined`. Other integer-indexed
String methods retain their ordinary NaN-to-zero behavior.

Exact local-vs-local Test262 A/B on base `c5bd4631724afa`:

- JS-host directory: 19/25 → 19/25; ES5 subset: 15/21 → 15/21.
- Standalone directory: 15/25 → 17/25; ES5 subset: 11/21 → 13/21.
- Fail→pass: `S15.5.4.8_A1_T10.js` and `S15.5.4.8_A4_T3.js`.
- Pass→fail: none. Every remaining failure kept the same normalized signature.

---

# Standalone re-grounding (s78-dev2, 2026-08-01)

Sprint 78 lever: raise ≤ES5 conformance in the **standalone** lane. Everything
below is measured; where a hypothesis was refuted, the refutation is kept
because it is the expensive part.

## Two-lane decomposition — this is a LANE GAP, not "unimplemented"

Scope: `built-ins/String/prototype/**` filtered to `es5id:` frontmatter.
Sources: `.test262-cache/test262-standalone-current.jsonl` and
`test262-current.jsonl`, same baselines run `20260801-010858`.
**Rows floored:** 630 es5id files exist; 630 have a standalone row, 629 have a
default row, so **629 are comparable**. The 1 missing row is reported, not
silently dropped.

| lane           | pass    | of 629 |
| -------------- | ------- | ------ |
| **standalone** | 412     | 65.5 % |
| **default**    | 552     | 87.8 % |

2×2 over the same 629 files:

| bucket                                | n       |
| ------------------------------------- | ------- |
| pass in BOTH lanes                    | 395     |
| fail in BOTH lanes                    | 60      |
| **default passes, standalone fails**  | **157** |
| standalone passes, default fails      | 17      |

**157 vs 60 settles it**: the dominant failure mode is a standalone lane gap,
not a feature nobody implemented. Excluding the 51 RegExp-engine codegen
refusals (explicitly out of this issue's scope), 119 of 166 standalone failures
pass on default (71.7 %).

Causal buckets of the 218 standalone ≤ES5 failures (host-pass count in
brackets — that is what turns "a failure" into "a standalone-only defect"):

| n   | bucket                                   | host-pass |
| --- | ---------------------------------------- | --------- |
| 113 | assertion mismatch                       | 82        |
| 51  | RegExp-engine refusal (OUT of scope)     | 38        |
| 24  | null/undefined receiver deref            | 9         |
| 15  | invalid Wasm binary (`__bindfn_*` locals) | 15        |
| 9   | host-import leak                         | 8         |
| 4   | unimplemented in standalone              | 3         |
| 2   | misc                                     | 2         |

## Instrument calibration (do not skip this when re-running)

`runTest262File(file, cat, 60000, "standalone")` — **status only** is
trustworthy (its error category and source location are artifacts; see
`reference_runtest262file_not_ci_path_status_only`). Calibrated against the
fresh standalone baseline on a 15-file subset: **14/14 agree, 0 disagreements**,
and a known-passing file reports `pass`. All A/B below is same-box, same-run,
same-file-list — never a local sweep diffed against a CI baseline.

Two instrument bugs were caught by controls before they could mislead, both
worth knowing:

- `compile()` is **async**. An un-awaited call makes `r.success` `undefined`, so
  **every** case — including a trivial positive control — reads as a compile
  failure. The positive control is the only reason this was caught.
- An ad-hoc "compile, instantiate, call the export, compare the value" harness
  **fails on both lanes** (host needs a real import object; standalone string
  returns do not marshal back naively). Its CONTROL failed, so the entire matrix
  it produced was discarded rather than read. See
  `project_wrapforhost_setexports_harness`.

## REFUTED: "generalize the two hardcoded `charAt` transfer arms"

The obvious fix shape, and it is wrong. `src/codegen/char-at-transfer.ts` holds
two arms keyed on the **literal string `"charAt"`** —
`buildTransferredCharAtMethodArm` (into `__extern_method_call`) and
`buildTransferredCharAtApplyArm` (into `__apply_closure`). Generalizing them
over the wired member set typechecks clean and flips **0 of 15** files.

The diagnostic that killed it, rather than a rationalization of the zero:
grep the emitted WAT for `__proto_method_\d+_<member>`. In the
`__instance = new Object(42); __instance.charCodeAt = String.prototype.charCodeAt`
shape **no proto-method closure is minted at all** — *not for `charCodeAt`, and
not for `charAt` either*. Since those arms exist to serve `charAt`, they cannot
be the mechanism by which anything works. The generalization was dead code and
was reverted.

(Also note: the first probe used `(String.prototype as any).charAt`. Per #3642
the **declaration shape** changes the lowering, so an `as any` cast is a
confound — re-probe with the exact untyped test262 spelling.)

## ROOT CAUSE, proven by kill-switch removal

Honest per-(shape, member) matrix, receiver `new Object(42)`, calibrated
instrument, CONTROL (primitive-string receiver) green on every arm. The
kill-switch forces `emitStringProtoMemberBody` to refuse, so the caller falls
through to the legacy lowering:

| arm                       | `String.prototype.M.call(obj)` | `obj.M = String.prototype.M; obj.M()` | total     |
| ------------------------- | ------------------------------ | ------------------------------------- | --------- |
| current `main`            | 5/14                           | 1/14                                  | 6/28      |
| **String wiring refused** | **14/14**                      | 2/14                                  | **16/28** |

The split is exact and inverts this issue's assumption. The members that FAIL
`.call()` are precisely the ones **#2875 wired** (`charCodeAt`, `indexOf`,
`lastIndexOf`, `trim`, `at`, `codePointAt`, `includes`, `startsWith`,
`endsWith`). The ones that PASS are the ones **not** wired (`toUpperCase`,
`slice`, `concat`) and therefore fall through to the legacy path — plus
`substring`/`charAt`, which have bespoke bodies.

**The reflective wiring is currently WORSE than the path it intercepts.**

### Why — a superseded fix that was never removed

- **#2875** added the wired bodies on this stated motivation: *"the reflective
  path returns `undefined` and lands on a legacy `.call` that drops `thisArg`
  and returns 0."* True when written.
- **#3254** (status `done`, sprint 72, 2026-07-13) then added
  `emitBorrowedStringReceiverToString` as a `receiverOverride` on the borrowed
  dispatch, covering **every** method in `STANDALONE_STR_PROTO_METHODS`
  (`calls.ts:6966`) — which contains every member the switch unwires.

So #2875's motivating defect was fixed by #3254 in the legacy path, but the
wiring that existed only to work around it stayed, and now intercepts *ahead* of
the corrected path. This is a **revert of a superseded fix**, not a new feature.

### The removal does NOT cost the descriptor surface (verified, not assumed)

Descriptor/value-read callers pass `refusalBodyFallback: true`, so they still
get a minted closure with correct metadata even when `emitMemberBody` refuses;
only CALL dispatch falls through. Asserted empirically on both arms rather than
read off the comment:

| case                                                | baseline | wiring refused |
| --------------------------------------------------- | -------- | -------------- |
| `String.prototype.charCodeAt.name` / `.length`      | pass     | **pass**       |
| `gOPD(String.prototype,"charCodeAt")` value/writable | pass     | **pass**       |
| `charCodeAt.hasOwnProperty('length')`                | pass     | **pass**       |

## THREE populations — do not conflate them in flip accounting

Removing the wiring fixes exactly one of three. Naming them so the residual is
not later misread as a regression:

- **P1 — literal `String.prototype.M.call(obj)`.** Syntactic; #3254 covers it.
  **Fixed by the removal** (5/14 → 14/14 on the micro matrix).
- **P2 — transferred `obj.M = String.prototype.M; obj.M()`.** The single
  largest sub-bucket (30 ≤ES5 files, 27 host-pass). Goes 1/14 → 2/14 — i.e.
  **essentially untouched**. Legacy does not cover it either. This is a
  genuinely separate second defect and needs its own root-cause pass.
- **P3 — non-syntactic spellings.** `#3254`'s override fires only when
  `typeName`/`methodName` are compile-time constants, so it cannot see:

  | spelling                                             | baseline | wiring refused |
  | ---------------------------------------------------- | -------- | -------------- |
  | `var m = String.prototype.charCodeAt; m.call(o,0)`   | fail     | fail           |
  | `String.prototype.charCodeAt.apply(o,[0])`           | fail     | fail           |
  | `Function.prototype.call.bind(String.prototype.M)`   | fail     | fail           |

  Unchanged by the removal — the wiring was not helping these either. The last
  row is the propertyHelper/uncurryThis idiom and is the **#3571** seam; #3571's
  own S1 analysis (`66ab19f84`) records that its host arm landed via #3635 and
  only the standalone arm remains.

**So the removal is strictly dominant on everything measured**: it fixes P1,
regresses nothing, and leaves P2/P3 exactly as broken as they already are. It is
not a tradeoff.

## Adjacent, separate: the `__bindfn` invalid-Wasm cluster

The 15 "invalid Wasm binary" files are corpus-wide **28 files, 25 host-pass**,
one validation message (`call[N] expected type externref, found ref.null of
type (ref null N)`), locals `__bindfn_tgt/__bindfn_arg/__bindfn_args` ⇒ the
standalone arm of `compileFunctionBind` (`calls.ts:2277`). It is the
propertyHelper family but a **compile-time** sub-mode, distinct from the runtime
receiver-drop mode #3571 documents, so it does not double-attribute. A synthetic
`Function.prototype.call.bind(...)` does **not** reproduce it (positive control
green, so the instrument was live) — the trigger needs the full
`propertyHelper`/`verifyNotWritable` shape. Keep it in its own PR.
