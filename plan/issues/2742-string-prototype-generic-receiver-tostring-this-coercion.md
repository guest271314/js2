---
id: 2742
title: "String.prototype methods: ToString(this) generic-receiver coercion, RequireObjectCoercible, and function `.length` own property"
status: in-progress
assignee: ttraenkler/opus-loop-d
sprint: current
created: 2026-06-27
updated: 2026-07-26
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
# (#3102 ratchet) The fix adds `_wrapAccessorGetterReturn` — a host-marshalling
# bridge that must sit beside its siblings `_wrapExecReturnForHost` /
# `_maybeWrapCallableUnknownArity` in runtime.ts, since it composes directly with
# the accessor wiring at the single `Object.defineProperty` accessor site. There
# is no subsystem module for host-value marshalling to move it to, and splitting
# one bridge away from the cache/discriminator helpers it calls would be worse
# than the +34 lines (~2/3 of which are the rationale comment recording why the
# generic call-exit marshal was reverted — #3123/#2835).
loc-budget-allow:
  - src/runtime.ts
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
