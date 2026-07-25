---
id: 2742
title: "String.prototype methods: ToString(this) generic-receiver coercion, RequireObjectCoercible, and function `.length` own property"
status: in-progress
assignee: ttraenkler/issue-2742-fn-length-dontenum
sprint: 67
created: 2026-06-27
updated: 2026-06-27
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
es_edition: ES5
language_feature: string-methods
goal: es5-complete
related: [2670]
depends_on: []
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
