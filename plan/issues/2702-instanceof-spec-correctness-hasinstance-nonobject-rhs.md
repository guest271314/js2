---
id: 2702
title: "instanceof spec correctness: non-object RHS TypeError, Symbol.hasInstance protocol, null-deref edge cases"
status: ready
sprint: 67
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: ES2015
language_feature: instanceof
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2702 — instanceof spec correctness: HasInstance, non-object RHS, Symbol.hasInstance

## Problem

The `instanceof` operator has three correctness gaps vs ECMAScript §13.10 InstanceofOperator:

**(a) Non-object / non-callable RHS must throw TypeError.** When the RHS is not an object (`true instanceof true`, `x instanceof Math` where Math is not callable), or when RHS is an object but not callable and has no `Symbol.hasInstance`, the spec mandates a TypeError. We currently produce wrong results or throw the wrong error type.

**(b) `Symbol.hasInstance` well-known method protocol is not implemented.** If the RHS has a callable `@@hasInstance` property, §13.10.2 step 2 requires calling it and returning ToBoolean of the result. We currently ignore `Symbol.hasInstance` entirely, so `symbol-hasinstance-invocation`, `symbol-hasinstance-to-boolean`, `symbol-hasinstance-not-callable`, and `symbol-hasinstance-get-err` all fail.

**(c) null/undefined LHS or prototype-getter edge cases.** `Cannot access property on null or undefined` in `S15.3.5.3_A3_T1/T2`, `S15.3.5.3_A2_T5`, `S11.8.6_A7_T3` indicates a null-deref when walking the prototype chain. `prototype-getter-with-object` / `prototype-getter-with-object-throws` assert that a getter on `Symbol.hasInstance` or `.prototype` is called correctly.

Spec: ECMAScript §13.10 — Relational Operators — Runtime Semantics, InstanceofOperator steps 1–7.

Note: #1325 (a perf optimization using a built-in type-tag registry to avoid the host) is a separate optimization concern, NOT this correctness fix.

## Failing tests (test262 baseline 2026-06-26)

```
test/language/expressions/instanceof/symbol-hasinstance-not-callable.js
test/language/expressions/instanceof/S15.3.5.3_A2_T6.js
test/language/expressions/instanceof/S15.3.5.3_A2_T2.js
test/language/expressions/instanceof/S11.8.6_A2.4_T1.js
test/language/expressions/instanceof/S11.8.6_A3.js
test/language/expressions/instanceof/symbol-hasinstance-get-err.js
test/language/expressions/instanceof/S11.8.6_A6_T1.js
test/language/expressions/instanceof/S11.8.6_A6_T2.js
test/language/expressions/instanceof/S11.8.6_A2.1_T3.js
test/language/expressions/instanceof/S15.3.5.3_A3_T1.js
test/language/expressions/instanceof/S15.3.5.3_A2_T5.js
test/language/expressions/instanceof/prototype-getter-with-object-throws.js
test/language/expressions/instanceof/S11.8.6_A6_T4.js
test/language/expressions/instanceof/S11.8.6_A2.4_T4.js
test/language/expressions/instanceof/primitive-prototype-with-object.js
test/language/expressions/instanceof/prototype-getter-with-object.js
test/language/expressions/instanceof/symbol-hasinstance-to-boolean.js
test/language/expressions/instanceof/S15.3.5.3_A3_T2.js
test/language/expressions/instanceof/symbol-hasinstance-invocation.js
test/language/expressions/instanceof/S11.8.6_A7_T3.js
```

### Sub-groups

**Non-callable / non-object RHS TypeError (~8 tests)**
- `S11.8.6_A3.js` — `true instanceof true` must throw TypeError
- `S11.8.6_A6_T1.js`, `S11.8.6_A6_T2.js`, `S11.8.6_A6_T4.js` — `x instanceof Math` must throw TypeError (not callable, no HasInstance)
- `S15.3.5.3_A2_T2.js`, `S15.3.5.3_A2_T5.js`, `S15.3.5.3_A2_T6.js` — RHS not an object → TypeError
- `S11.8.6_A2.1_T3.js` — wrong throw type (ReferenceError instead of expected result)

**Symbol.hasInstance protocol (~4 tests)**
- `symbol-hasinstance-invocation.js` — `@@hasInstance` must be called; `callCount` assert
- `symbol-hasinstance-to-boolean.js` — result must be ToBoolean of `@@hasInstance` return
- `symbol-hasinstance-not-callable.js` — non-callable `@@hasInstance` must throw TypeError
- `symbol-hasinstance-get-err.js` — getter on `@@hasInstance` that throws must propagate

**Null/undefined prototype-chain deref (~5 tests)**
- `S15.3.5.3_A3_T1.js`, `S15.3.5.3_A3_T2.js`, `S11.8.6_A7_T3.js` — null deref during prototype walk
- `prototype-getter-with-object.js`, `prototype-getter-with-object-throws.js` — `.prototype` getter invoked correctly

**Other correctness (~3 tests)**
- `S11.8.6_A2.4_T1.js`, `S11.8.6_A2.4_T4.js` — `(OBJECT = Object, {}) instanceof OBJECT` side-effect ordering
- `primitive-prototype-with-object.js` — RHS has primitive `.prototype` → TypeError

## Root cause (suspected)

The `instanceof` codegen in `src/codegen/expressions.ts` (BinaryExpression handler for `instanceof`) likely:
1. Only checks the nominal WasmGC type path and falls through on non-callable RHS without throwing.
2. Never consults `Symbol.hasInstance` on the RHS — the @@hasInstance lookup is absent.
3. The prototype walk does not guard against `null` returns from `Object.getPrototypeOf`, causing null-deref traps.

The fix requires implementing the full §13.10.2 InstanceofOperator algorithm: check `Symbol.hasInstance` first; if absent, check OrdinaryHasInstance; in OrdinaryHasInstance check callability and walk the prototype chain with null guards.

## Acceptance criteria

All 20 listed tests flip from fail to pass. No regression in `expressions/instanceof/` (currently-passing tests stay green). Full CI green.

## Notes

- Related: #1325 (optimization, perf — do NOT conflate with this correctness fix).
- The `S11.8.6_A2.4_T*` side-effect-ordering tests may share a root cause with the null-deref tests (prototype getter called before object check).
- If `Symbol.hasInstance` implementation requires broader WellKnownSymbol support changes, note them in the PR but keep this issue focused on `instanceof` correctness only.
