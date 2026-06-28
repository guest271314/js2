---
id: 2763
title: "[SUBSTRATE][ARCH] instanceof value-rep residual: cross-realm Object/Function identity + .prototype access on dynamic Function values"
status: ready
sprint: Backlog
created: 2026-06-28
updated: 2026-06-28
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: investigation
area: runtime
language_feature: instanceof
goal: core-semantics
parent: 2740
depends_on: []
---
# #2763 — instanceof value-representation residual (cross-realm identity + dynamic-Function `.prototype`)

Architect-scoped split of the #2740 umbrella. These two clusters are NOT
instanceof-operator bugs — they are value-representation gaps that surface
through `instanceof` tests. They fold into the value-rep / IR substrate roadmap.
Verified against current `main` on 2026-06-28 (see #2740 for the full trace).

## Cluster 1 — cross-realm `Object`/`Function` constructor identity (value-rep)

`var O = Object; ({}) instanceof O` returns **false** at runtime (should be
`true`). The DIRECT `({}) instanceof Object` only passes because it is
*static-folded* in codegen, masking the gap.

Root cause (traced in `_instanceofResult`, `src/runtime.ts`): when the RHS
constructor flows through a variable to the dynamic path
(`__instanceof_check`), the `Object`/`Function` globals arrive as a
**sandbox-realm** `function Object(){ [native code] }`, so `target === Object`
(the host-realm intrinsic) is **false**; and the `{}` LHS arrives as a *real
host object* whose `[[Prototype]]` is host `Object.prototype`, so the native
`v instanceof target` walks a mismatched prototype chain and yields false. The
explicit WasmGC-struct Object/Function recognition (`_isWasmStruct(v)` +
`target === Object`) does not fire because (a) `v` is a real object not a wasm
struct here, and (b) the realm-split breaks the identity compare.

Affected test262 (failing on main):
- `language/expressions/instanceof/S11.8.6_A2.1_T1.js` (`var O=Object; ({}) instanceof O === true`)
- `language/expressions/instanceof/S11.8.6_A2.4_T1.js` (`var O=0; (O=Object,{}) instanceof O` — also hits the over-eager static-throw)
- `language/expressions/instanceof/S11.8.6_A2.4_T4.js` (`(O=Object,{}) instanceof O`, undeclared O)
- `language/expressions/instanceof/S11.8.6_A6_T1.js` (`({}) instanceof this`; top-level `this` is `undefined`, dynamic path returns false instead of throwing TypeError)
- `language/expressions/instanceof/S11.8.6_A6_T4.js` (plain-function `new MyFunct` + `instanceof MyFunct`/`Function`/`Object` + non-callable throw)

Note: there is ALSO an over-eager codegen static-throw — `compileHostInstanceOf`
in `src/codegen/expressions/identifiers.ts` throws `TypeError` unconditionally
when the RHS *static type* is exclusively primitive (e.g. `var O = 0`), which is
unsound for a reassignable binding (`O = Object` at runtime). Narrowing that
static-throw to literal/keyword-primitive RHS only (routing identifiers to the
dynamic check) is the codegen half; it must land together with the realm-safe
runtime recognition or A2.4_T1 flips from a wrong-throw to a wrong-`false`.

## Cluster 2 — `.prototype` access on dynamic `Function(...)` / `new Function` values traps

`Function(...)` and `new Function` DO return real callables now (the
`src/runtime.ts` comment claiming they "lower to undefined" is **STALE** —
verified: `typeof Function("return 1") === "function"`). But reading
`.prototype` off such a value traps with the internal
`"TypeError: Cannot access property on null or undefined"` — a property-access
gap on Function-typed dynamic values, not an instanceof bug. This is the cluster
the original #2740 framing mis-labeled "null/undefined LHS": the null-deref is on
`FACTORY.prototype`, after `FACTORY = Function(...)`, not in the instanceof.

Affected test262 (failing on main, all blocked on this `.prototype` trap before
instanceof even runs):
- `S15.3.5.3_A2_T6.js` (`new Function; FACTORY.prototype="error"` → expect TypeError)
- `S15.3.5.3_A2_T2.js` (`new Function; FACTORY.prototype=undefined` → expect TypeError)
- `S15.3.5.3_A3_T1.js` (`Function("…"); FACTORY.prototype.type=1; new FACTORY`)
- `S15.3.5.3_A2_T5.js` (`Function("…"); FACTORY.prototype.name=…`)
- `S11.8.6_A7_T1.js` / `S11.8.6_A7_T3.js` (`new Function; .constructor`/`.prototype`)
- `S15.3.5.3_A3_T2.js` (`Function(); FAKEFACTORY.prototype = Object.prototype`)

## Acceptance criteria
- `var O = Object; ({}) instanceof O` → `true`; `var F = Function; (function(){}) instanceof F` → `true` (realm-safe constructor identity in the dynamic instanceof path).
- `({}) instanceof this` (this = undefined) → throws `TypeError`.
- `.prototype` read/write on a `Function(...)` / `new Function` value no longer traps.
- No regression in the 28 instanceof tests currently green.

## Notes
- Spec: ES2023 §13.10.2, §7.3.20.
- Key sites: `src/runtime.ts` `_instanceofResult` (~2215), `__instanceof_check`/`__instanceof` (~12224); `src/codegen/expressions/identifiers.ts` `compileHostInstanceOf`/`tryStaticInstanceOf`; property-access for `.prototype` on Function values in `src/codegen/property-access.ts`.
- Architect should decide whether the realm-safe Object/Function recognition belongs in the runtime (`_instanceofResult`) or is subsumed by a broader value-rep change (the harness realm-split may itself need addressing).
