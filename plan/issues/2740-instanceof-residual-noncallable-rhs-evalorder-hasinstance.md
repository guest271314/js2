---
id: 2740
title: "instanceof residual: non-callable RHS TypeError, null/undefined LHS, evaluation-order ReferenceError, Symbol.hasInstance arg count"
status: ready
sprint: 67
created: 2026-06-27
updated: 2026-06-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: ES3
language_feature: instanceof
goal: test262-conformance
parent: 2702
depends_on: []
---
# #2740 — `instanceof` residual after #2702

`#2702` delivered the core `OrdinaryHasInstance` ordering (step 3 before step 4)
and the non-object RHS `TypeError`. The current main baseline
(`benchmarks/results/test262-current.jsonl`, HEAD = the 2026-06-27 baseline
refresh, 32 commits after the last #2702 fix) still shows **13 residual
`language/expressions/instanceof` fails** that group into four concrete bugs.

## Failing test262 files (current main)

**(a) Non-callable RHS must throw `TypeError` ("Only Function objects implement
[[HasInstance]]")** — we currently do not throw:
- `test/language/expressions/instanceof/S11.8.6_A6_T1.js`
- `test/language/expressions/instanceof/S11.8.6_A6_T4.js`
- `test/language/expressions/instanceof/S15.3.5.3_A2_T6.js`
- `test/language/expressions/instanceof/S15.3.5.3_A2_T2.js`
- `test/language/expressions/instanceof/S11.8.6_A2.4_T1.js`

**(b) `null` / `undefined` LHS — our compiler raises an internal null-deref
("TypeError: Cannot access property on null or undefined") instead of returning
`false`** per `OrdinaryHasInstance` step 2 (`If Type(O) is not Object, return
false`):
- `test/language/expressions/instanceof/S15.3.5.3_A3_T1.js`
- `test/language/expressions/instanceof/S15.3.5.3_A2_T5.js`
- `test/language/expressions/instanceof/S11.8.6_A7_T3.js`

**(c) Evaluation order — RHS reference must be evaluated and may throw
`ReferenceError`; the LHS-then-RHS order and the "joined objects" identity
checks fail:**
- `test/language/expressions/instanceof/S11.8.6_A2.1_T3.js` (expects
  `ReferenceError`, we throw `Test262Error`)
- `test/language/expressions/instanceof/S11.8.6_A2.4_T4.js`
- `test/language/expressions/instanceof/S15.3.5.3_A3_T2.js`

**(d) `Symbol.hasInstance` invocation protocol — the well-known method must be
called with exactly one argument and its return ToBoolean-coerced:**
- `test/language/expressions/instanceof/symbol-hasinstance-invocation.js`
  (`assert.sameValue(args.length, 1)`)
- `test/language/expressions/instanceof/prototype-getter-with-object.js`
  (`[]` should be `instanceof Function.prototype` via a prototype getter)

## Acceptance criteria

- All 5 files in group (a) pass: a `V instanceof C` where `C` is not callable
  throws `TypeError`.
- All 3 files in group (b) pass: `null`/`undefined`/primitive LHS yields `false`
  (no internal null-deref trap).
- Group (c): RHS is evaluated as a reference; an unresolvable RHS throws
  `ReferenceError`; joined-object identity holds. ≥2 of 3 pass.
- Group (d): `Symbol.hasInstance` is invoked with `argumentsList` length 1 and
  the result ToBoolean-coerced. Both files pass.
- **Target: ≥11 of 13 residual instanceof tests fixed.** No regression in the
  20 instanceof tests already green from #2702.

## Notes
- Spec: ES2023 §13.10.2 `InstanceofOperator`, `OrdinaryHasInstance`.
- BigInt-RHS and `with`-bound RHS instanceof tests are out of scope (blocked
  clusters, see sprint 67 deferred list).
