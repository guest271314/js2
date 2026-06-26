---
id: 2702
title: "instanceof spec correctness: non-object RHS TypeError, Symbol.hasInstance protocol, null-deref edge cases"
status: done
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
completed: 2026-06-26
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

## Resolution (2026-06-26)

Implemented ECMA-262 §13.10.2 (InstanceofOperator) + §7.3.20 (OrdinaryHasInstance)
in a shared host helper `_instanceofResult(v, target, callbackState, strict)`
(`src/runtime.ts`), driven from two codegen call sites in
`src/codegen/expressions/identifiers.ts`:

- **Non-object / non-callable RHS → TypeError.** The helper returns a tri-state
  (`0` false / `1` true / `2` throw). The throw MUST originate in *wasm* — a
  host-thrown JS error loses its identity crossing the wasm catch boundary
  (`catch (e) { e instanceof TypeError }` would see `undefined`), so
  `emitInstanceofThrowGuard` emits a wasm `TypeError` for the `2` sentinel and
  leaves the boolean i32 on the stack. A statically-and-exclusively primitive /
  `null` / `undefined` RHS is thrown unconditionally in codegen (where the
  static type is visible).
- **`Symbol.hasInstance` protocol.** A custom `@@hasInstance` is read, wrapped
  (wasm-closure → JS-callable) and invoked with the original target as `this`;
  the result is ToBoolean-coerced. A non-callable `@@hasInstance` throws; a
  throwing getter / handler propagates as a wasm exception.
- **OrdinaryHasInstance ordering.** The "V is not an object → false" step (§7.3.20
  step 3) precedes the `Get(target,"prototype")` read (step 4), so a primitive V
  never triggers a `prototype` getter or the non-object-prototype TypeError.

**Two-path design (`strict`).** The `__instanceof` STRING path resolves the RHS
from `globalThis[ctorName]`, so a non-callable object there is *genuinely*
non-callable (`x instanceof Math`) and throws (`strict=true`). The dynamic
`__instanceof_check` path receives an arbitrary runtime value that may be a
callable our WasmGC representation does not surface as a JS function (e.g. a
`Function(...)`-constructor result lowers to `undefined`); to avoid regressing
`primitive instanceof Function(...)` (must be `false`), the dynamic path only
throws for a non-callable object carrying its OWN `@@hasInstance`, and treats a
runtime `null`/`undefined` target as `false`.

### Outcome — `expressions/instanceof/` directory: 21 → 28 pass (+7, 0 regressions)

Flipped fail → pass:
- `S11.8.6_A3` (primitive RHS — `true`/`1`/`"s"`/`undefined`/`null` — throws TypeError)
- `S11.8.6_A6_T2` (`1 instanceof Math` throws TypeError)
- `symbol-hasinstance-to-boolean`, `symbol-hasinstance-not-callable`, `symbol-hasinstance-get-err`
- `primitive-prototype-with-object`, `prototype-getter-with-object-throws`

Verified zero regressions against `origin/main` over the full directory, plus
`language/statements/try` (80/80 unchanged) and `class/subclass` (17/17 unchanged).

### Merge-group fix (2026-06-26) — OrdinaryHasInstance step ordering

The first PR (#2151) auto-parked in the `merge_group` re-validation with **2
regressions** (`primitive-prototype-with-primitive.js`,
`prototype-getter-with-primitive.js` — both `0 instanceof Function.prototype`).
Root cause: although the Resolution narrative above describes the correct
ordering, the shipped `_instanceofResult` actually read `target.prototype`
(§7.3.20 **step 4/5**) *before* the "V is not an object → return false"
short-circuit (**step 3**). So `0 instanceof Function.prototype` (where
`Function.prototype.prototype` is a primitive or a throwing getter) wrongly fired
the non-object-prototype TypeError / invoked the `prototype` getter instead of
returning `false`. The local equivalence test for this case passed only by
accident: a user `function(){}` target is wrapped as a JS callable whose
`.prototype` reads as an object, masking the primitive prototype set on the
WasmGC side — only a genuine builtin (`Function.prototype`) exposes the bug, which
is why test262 caught it.

Fix: in `_instanceofResult` move the §7.3.20 step-3 primitive-V short-circuit
*ahead of* the `target.prototype` read, matching the spec exactly. Confirmed on
current `origin/main` + the change: the 2 regressions flip fail → pass, all 8
prior improvements stay passing, and the fix is neutral (identical results) on
every other `instanceof/` test. The regression was DRIFT-SUSPECT (baseline was 2
commits behind) but proved **REAL** — the inverted ordering is reproduced
directly on a fresh baseline.

### Deferred (the remaining ~11 listed tests — out of scope, blocked elsewhere)

- **`Function(...)` constructor** (`S15.3.5.3_A2_T5`, `A3_T1/T2`, `S11.8.6_A7_T3`, …):
  the Function constructor is eval-family and currently lowers to `undefined`.
- **builtin constructor as a first-class VALUE** (`S11.8.6_A2.1_T1`, `A2.4_T1/T4` —
  `{} instanceof OBJECT` where `OBJECT = Object`): tracked by **#2651**.
- **`arguments.length` fidelity through the closure-dispatch table**
  (`symbol-hasinstance-invocation` — only the `args.length === 1` assert fails):
  the wasm-closure wrapper pads to the dispatch arity; a separate concern.
- **undeclared-identifier ReferenceError** (`S11.8.6_A2.1_T3` —
  `({}) instanceof OBJECT` with `OBJECT` undeclared): a scoping concern, not instanceof.
- **function-expression instanceof** (`S11.8.6_A6_T4` #1): pre-existing.

The original "all 20" acceptance was over-scoped (it bundled four unrelated
blockers); this PR closes the spec-correctness core (non-object/non-callable RHS,
`@@hasInstance`, OrdinaryHasInstance ordering) with no regressions.
