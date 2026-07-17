---
id: 2763
title: "[SUBSTRATE][ARCH] instanceof value-rep residual: cross-realm Object/Function identity + .prototype access on dynamic Function values"
status: ready
sprint: fable-final
created: 2026-06-28
updated: 2026-07-17
priority: medium
horizon: l
feasibility: hard
model: fable
fable_role: spec
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
_static-folded_ in codegen, masking the gap.

Root cause (traced in `_instanceofResult`, `src/runtime.ts`): when the RHS
constructor flows through a variable to the dynamic path
(`__instanceof_check`), the `Object`/`Function` globals arrive as a
**sandbox-realm** `function Object(){ [native code] }`, so `target === Object`
(the host-realm intrinsic) is **false**; and the `{}` LHS arrives as a _real
host object_ whose `[[Prototype]]` is host `Object.prototype`, so the native
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
when the RHS _static type_ is exclusively primitive (e.g. `var O = 0`), which is
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

## Reground (2026-07-02, dev-2912f, task #22)

Re-verified against current main (baseline `46e390c`-era jsonl + direct
compile/run probes):

**Cluster 1 — partially LANDED.** The realm-safe constructor recognition has
merged: `S11.8.6_A2.1_T1` (the headline `var O = Object; ({}) instanceof O`)
now **passes**. Still failing: `A2.4_T1`, `A2.4_T4`, `A6_T1`, `A6_T4`.

**The codegen static-throw narrowing is NOT independently landable** —
implemented and probe-tested this session, then deliberately reverted:

- Mechanically correct: exempting reassignable (`var`/`let`/param/undeclared)
  identifier RHS from the #2702 static throw keeps every currently-correct
  shape correct (`var num = 100; x instanceof num` still throws — the runtime
  `_instanceofResult` throws for genuine primitive targets; literal and
  `const`-primitive RHS keep the static throw; `undefined`/`NaN`/`Infinity`
  must stay static — a dynamic `undefined` target deliberately answers
  `false`).
- But it flips ZERO tests: in `A2.4_T1` (`var OBJECT = 0;
(OBJECT = Object, {}) instanceof OBJECT`) the binding compiles to an
  f64-typed local, the function value does not survive the `OBJECT = Object`
  store, and the dynamic check receives a NUMBER → same TypeError, now from
  the runtime. **The true blocker is value-rep widening of
  primitive-initialized mutable bindings later assigned function values** —
  exactly this issue's [SUBSTRATE] scope. Land the narrowing TOGETHER WITH
  the widening, not before.
- `A2.4_T4` (undeclared `OBJECT`): already routes dynamically (type `any`);
  fails because the non-strict undeclared-global assignment/read path drops
  the value (probe: returns `false`, expected `true`) — same substrate family.
- `A6_T1` (`({}) instanceof this`, top-level `this === undefined`): dynamic
  path answers `false` by the documented conservative-undefined rule in
  `_instanceofResult`. Note the rule's justification ("`Function(...)` lowers
  to undefined") is confirmed STALE (cluster 2 header) — tightening
  undefined→TypeError on the dynamic path is plausible now but must be
  regression-swept against everything relying on the conservative `false`.
- `A6_T4`: case 2 (`instanceof Function` → false) passes; case 1
  (`new MyFunct() instanceof MyFunct` with a plain function expression)
  returns `false` — plain-function `.prototype`/proto-chain identity gap,
  distinct from the realm work.

**Cluster 2 — one incidental flip.** `S11.8.6_A7_T1` now passes;
`S15.3.5.3_A2_T2/T5/T6`, `A3_T1/T2`, `S11.8.6_A7_T3` still fail (the
`.prototype`-on-dynamic-Function trap stands).

Issue stays open, architect-scoped, with the value-rep widening as the
gating dependency for the cluster-1 residuals.
