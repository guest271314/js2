---
id: 3481
title: "bigint/symbol coercion: value-substrate ToPrimitive/ToNumeric fidelity (host ~164 fails) — architect-spec hand-off"
status: ready
created: 2026-07-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
goal: test262-conformance
model: opus
sprint: current
horizon: xl
related: [3422]
---

# #3481 — bigint/symbol coercion fidelity (value substrate)

**HAND-OFF ISSUE — needs a senior-dev + architect-spec, NOT a developer quick-fix.**
Overlaps the toPrimitive-nominal-struct epic (see MEMORY: project_2358_toprimitive_*,
project_toprimitive_nominal_struct_gap). Verified via verify-first while working #3422;
do not fold into a throw-class fix (that was the initial mis-framing — the arithmetic
`+`/coercion operators already throw real `instanceof TypeError`).

## Scope (host oracle-v8 baseline 2026-07-19, ~164 fails; Temporal excluded)

Two sub-families, both rooted in the value substrate's ToPrimitive/ToNumeric path,
NOT in throw-class (the delete/read-only bare-string bug fixed by #3422/#3471):

### A. Wrong-coercion (~106): we throw the CORRECT TypeError but shouldn't throw at all
The thrown errors are already real `instanceof TypeError`; the bug is that we coerce
Symbol/BigInt to number where the spec does something else. Repros:
- `Object(2n) * 2n` → we throw "Cannot mix BigInt and other types" because we do NOT
  ToPrimitive-unwrap the BigInt **wrapper object** to its primitive `2n` before the
  multiply (should be `4n`). (`language/expressions/multiplication/bigint-wrapped-values.js`)
- `Array[Symbol.species]` descriptor read / `Map.prototype[Symbol.iterator]`
  verifyProperty → a Symbol key gets coerced to a number during normal execution
  ("Cannot convert a Symbol value to a number in __module_init / isWritable").
- Signatures: "Cannot convert a Symbol value to a number" ×79, "Cannot mix BigInt and
  other types" ×27.

### B. Missing-throw (~26): ToPrimitive result not re-validated
An object whose `@@toPrimitive`/`valueOf` returns a Symbol/BigInt, passed where a
string/integer/index is expected — we call ToPrimitive, get the Symbol/BigInt back, and
do NOT re-validate it on the subsequent ToString/ToInteger/ToIndex, so no throw occurs.
- ToPrimitive-tangled (~16, same root as A): `String.prototype.indexOf`
  searchstring/position, `Error`/`AggregateError`/`SuppressedError`/`NativeError` message
  ToString, `DataView.getBigInt64` / `BigInt.asUintN` ToIndex, `ArrayBuffer` length.
  The runtime `__extern_to_string_default` DOES re-check Symbol (runtime.ts ~8722-8736),
  but the inlined codegen coercions (string-ops.ts `$__any_to_string`) and the
  ToInteger/ToIndex paths do not — route them through the checking helper.
- Genuinely isolated (~10, scattered across ~6 sites — could be split off as small
  independent fixes if desired): `1n >>> 1n` (BigInt has no `>>>`, must throw TypeError);
  `(x).toFixed(sym)` throws RangeError **before** the ToNumber TypeError (coercion-order
  bug — coerce fractionDigits before range-validating); `[].sort(Symbol())` comparefn
  IsCallable validation; `ArrayBuffer.prototype.slice` species-not-constructor;
  `String.fromCharCode(1n)` ToNumber(BigInt).

## Why hard / hand-off
The dominant A + B-tangled clusters require correct ToPrimitive/ToNumeric on nominal
struct wrappers (`Object(2n)`, boxed Symbol) and Symbol-keyed access — the same substrate
as the toPrimitive-nominal-struct work. Regression-prone; needs an architect spec that
sequences: (1) wrapper-object ToPrimitive unwrap, (2) ToString/ToInteger/ToIndex Symbol/
BigInt re-check on ToPrimitive results, (3) the isolated operator/arg-validation fixes.

## Acceptance
- `Object(2n) * 2n === 4n`; Symbol-keyed descriptor reads don't spuriously coerce.
- ToPrimitive returning a Symbol/BigInt into a String/Integer/Index context throws a real
  `instanceof TypeError` at the coercion site.
- The ~10 isolated cases (`>>>`, toFixed order, sort comparefn, species, fromCharCode) throw.
- Zero regression on the arithmetic-coercion cases that already pass.
