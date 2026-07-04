---
id: 2998
title: "Eliminate env::__instanceof_check leak for static-primitive LHS in standalone"
status: done
sprint: 69
priority: medium
horizon: s
assignee: ttraenkler/agent-instanceof
completed: 2026-07-02
goal: standalone-host-free
---

# Eliminate `env::__instanceof_check` leak for a static-primitive LHS (standalone)

## Problem

Leak-analysis round 5 (`plan/log/investigations/2026-07-02-leak-analysis-round5.md`)
flagged `env::__instanceof_check` as a **sole-import leaky-pass** lever — 17
standalone tests that pass but leak exactly that one host import:

```
language/expressions/instanceof/S15.3.5.3_A1_T1..T8   (<primitive> instanceof Function(...))
language/expressions/instanceof/prototype-getter-with-primitive
language/expressions/instanceof/primitive-prototype-with-primitive  (0 instanceof Function.prototype)
language/expressions/instanceof/S11.8.6_A2.4_T2/T3, S11.8.6_A6_T3
built-ins/TypedArray/... (4, TA-wrapper adjacent)
```

The fully-dynamic `instanceof` path (`emitDynamicInstanceOf` in
`src/codegen/expressions/identifiers.ts`) routes **every** `<value> instanceof
<dynamic-RHS>` (a non-builtin identifier RHS such as `FACTORY`, or a
non-identifier RHS such as `Function.prototype`) to the `__instanceof_check`
host predicate — so these otherwise-passing tests are not host-free.

## Root cause / scope decision (verified, not narrative)

A static-fold keyed on the **RHS type** (the #1729 / #2994 pattern) does **not**
apply here: in 8 of the 10 primitive-LHS tests the RHS is `any` (`var FACTORY;`
→ `FACTORY = Function(...)`), so there is no static type to fold on. A native
*dynamic* predicate would need runtime primitive-detection on an arbitrary
`anyref`, but the native `typeof` helper itself leaks `env::__typeof`, and the
object-LHS answer needs a full prototype-chain-walk membership test — that is the
**#2916 Slice B** substrate and is deliberately **deferred**.

The bounded, safe lever is the **left-hand operand**: when the LHS is statically
and *exclusively* a primitive, §13.10.2 → §7.3.20 OrdinaryHasInstance step 3
("If Type(O) is not Object, return false") resolves the operator to `false`
**without** reading `target.prototype` or walking any chain — a compile-time
constant, no host predicate needed.

## Fix

`emitDynamicInstanceOf` short-circuits, under `noJsHost` only, when
`isExclusivelyPrimitiveType(getTypeAtLocation(expr.left))` holds
(number / string / boolean / bigint / symbol / null / undefined / void / never;
never `Object` / `any` / `unknown` / non-primitive / type-parameter). It still
compiles **both** operands (spec evaluates LHS then RHS before any check —
preserving side effects and a RHS `ReferenceError`/accessor throw), discards
them, and pushes the constant `0`.

Gated on `noJsHost`: in the gc/host lane the import is satisfiable and the
runtime predicate still throws the spec TypeError for a genuine-primitive RHS
(`1 instanceof <runtime-non-object>`), so that lane stays byte-identical.

## Validation

- **Conversion (standalone):** 10 of the 13 instanceof-directory sole-leak tests
  flip leaky → host-free (`env=[]`): `S15.3.5.3_A1_T1..T7`,
  `prototype-getter-with-primitive`, `primitive-prototype-with-primitive`,
  `S11.8.6_A2.4_T2`. All still `pass`. The 3 remaining (`S15.3.5.3_A1_T8` and
  `S11.8.6_A2.4_T3` — `any` LHS; `S11.8.6_A6_T3` — function LHS) correctly still
  route to the host predicate (deferred to #2916).
- **No regressions:** full `language/expressions/instanceof/` standalone sweep
  before/after — **0** status flips (23 fail / 20 pass identical both sides);
  broader `Function/prototype/Symbol.hasInstance` + `Object/getPrototypeOf`
  sweep — **0** pass→fail.
- **gc/host lane byte-inert:** sha256 of the default-lane binary is identical
  before/after for 5 sampled tests (fold is `noJsHost`-gated).
- **Execution proof (non-vacuous):** flipping the folded constant to `1` (true)
  makes the 9 value-asserting tests **FAIL** — the assertions are live and
  genuinely verify the `false` result.
- `tests/issue-2998.test.ts` — 10 cases (primitive-LHS conversions, member-access
  RHS, object-LHS-not-folded negative, gc-lane-unchanged).

## Deferred (out of scope — #2916 Slice B)

Object-LHS dynamic `instanceof` (`obj instanceof userCtor`, `f instanceof f`)
needs a native prototype-chain-walk membership test; the `any`-LHS shapes
(`S15.3.5.3_A1_T8`, `S11.8.6_A2.4_T3`) need runtime primitive-detection. Both
belong to the broader substrate and remain host-backed for now.
