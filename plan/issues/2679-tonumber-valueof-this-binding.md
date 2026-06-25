---
id: 2679
title: "ToNumber/ToPrimitive invokes valueOf with the WRONG `this` (receiver identity lost) — breaks arg-*-to-number tests across builtins"
status: in-progress
assignee: ttraenkler/dev-2046
created: 2026-06-25
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: multi
language_feature: coercion, valueOf, toPrimitive
goal: spec-completeness
related: [1917, 2108, 1434, 2671]
sprint: 66
---

# #2679 — ToNumber calls `valueOf` with the wrong `this`

When ToNumber (§7.1.4) / ToPrimitive (§7.1.1) coerces an **object** to a number,
the object's `valueOf` (or `@@toPrimitive` / `toString`) must be called **with
the object itself as `this`** (§7.1.1.1 OrdinaryToPrimitive step 4.b:
`Call(method, O)`). The compiler invokes the method but binds the **wrong
`this`** — the receiver object's identity is lost.

## Evidence (current main, host mode)

```ts
var tv; var a = { valueOf() { tv = this; return 5; } };
+a;            tv === a  // false  ❌ (want true)
Number(a);     tv === a  // false  ❌
a * 1;         tv === a  // false  ❌
new Date(2016,6,1).setSeconds(a);  tv === a  // false  ❌
```

`callCount` is 1, `arguments.length` is 0, and the **returned value** is correct
(5) — only the `this` binding inside `valueOf` is wrong. So the funnel calls the
right method the right number of times with the right args; it just doesn't pass
the receiver object as `this`.

## Impact

This is a **general coercion-path** bug (NOT Date-specific): it breaks the
`arg-*-to-number.js` test262 cluster wherever a spec test asserts the `valueOf`
receiver — Date `set*` (≈14 fails: surfaced via #2671), plus any builtin/operator
that ToNumbers a user object and the test checks `this`. Cross-edition.

## Root cause (to confirm)

The ToNumber funnel (`compileExpression(arg, {kind:"f64"})` → the f64-coercion of
an `externref`/`any` with a user `valueOf`) routes through the host
`__to_primitive` / `_toPrimitiveSync` (runtime.ts) or the coercion engine
(`src/codegen/coercion-engine.ts`, #1917/#2108). The `valueOf` lookup + call must
invoke it as a METHOD on the original receiver (`recv.valueOf()`), preserving
`recv` as `this`. Suspect: the funnel reads `valueOf` off the object then calls
it free / on a re-wrapped externref, OR the host `_toPrimitive` invokes the
exported closure without threading the receiver as `this` (the #2659/#2664-family
externref-identity-through-the-host-bridge class — the same root that lost
`this`/object identity in the acorn work).

## Fix direction

Trace the ToPrimitive/`valueOf` invocation in `_toPrimitive`/`_toPrimitiveSync`
(runtime.ts) + the coercion-engine `valueOfClosureTypes`/`toPrimitiveHint` path:
ensure the method is called with the original receiver as `this` (`method.call(O)`
on the host side; `__current_this`/receiver-threaded dispatch in standalone).
Add a `this`-receiver regression test. Keep it routed through the single coercion
engine (#1917/#2108) — do NOT hand-roll a parallel ToPrimitive.

## Acceptance

- `valueOf`/`@@toPrimitive`/`toString` invoked during ToNumber/ToPrimitive of an
  object receive that object as `this` (`tv === a` in the repros above).
- The Date `set*` `arg-*-to-number.js` cluster (#2671) + other builtin
  `arg-*-to-number` tests asserting the receiver flip toward pass.
- Standalone + host both correct; routed through the coercion engine.

## Notes

- Surfaced by dev-2046 while working #2671 Date `set*` ToNumber ordering — the
  ordering/count/args were all already correct; only the `this` binding is wrong.
- Connected to the #2659/#2664-family externref-identity-through-host-bridge
  pattern (same "object identity lost crossing the boundary" root).

## Partial fix + residual (dev-2046, 2026-06-25)

**FIXED (string-hint + @@toPrimitive `this`-binding):** threaded the receiver
through the host coercion funnel so the compiled method body sees the right
`this`:
- `runtime.ts` `_toPrimitive` / `_hostToPrimitive`: dispatch the compiled
  valueOf/toString/@@toPrimitive closure via `__call_fn_method_0` /
  `__call_fn_method_1` (which install `__current_this = receiver`) BEFORE the
  receiver-less `__call_fn_0` / `__call_fn_1` fallbacks.
- `index.ts` `emitToPrimitiveMethodExports`: `__call_valueOf` / `__call_toString`
  now save `__current_this`, install param-0 (the receiver), run the dispatch,
  and restore — so the `call_ref` of the method closure runs with the correct
  `this`.

Verified (`tests/issue-2679-toprimitive-this.test.ts`, 5/5): `'' + a`,
`String(a)`, and `@@toPrimitive` all bind `this === a`; value-correctness
unchanged. Regression-free across the runnable coercion/toPrimitive suites
(#1917-toprimitive, #1732-symbol-coercion, call-arg-coercion, #1716, #866).

**RESIDUAL (number/default-hint `valueOf` — STILL WRONG):** `+a` / `Number(a)` /
`a*1` where `a = {valueOf(){…this…}}` still bind the WRONG `this`. Pinned facts:
- The valueOf IS called exactly once and returns the correct VALUE (`+a` of
  `{valueOf:()=>5}` → 5). Only the `this` inside valueOf is wrong (`tv !== a`).
- The string-hint path (toString) through the SAME `_toPrimitive.tryMethod` +
  `__call_toString` wrapper binds `this` correctly — so the divergence is
  specific to the number-hint valueOf dispatch ARM, OR the object-literal
  `valueOf` method reads `this` from a source other than `__current_this` (a
  captured/closure environment) that the string-hint toString does not.
- `+a` → `__unbox_number` (unbox/number intent, runtime.ts) → `_toPrimitive(v,
  "number")` → `tryMethod("valueOf")`. Next step: instrument which arm of
  `tryMethod("valueOf")` fires for an object-literal valueOf (sidecar-closure /
  `__sget_valueOf`→`__call_valueOf` / exported `__call_valueOf`), and decode the
  valueOf closure body's WAT to see whether it reads `this` from
  `__current_this` or a captured value. If it's the latter (object-literal method
  `this` not sourced from `__current_this`), the fix is in the
  object-literal-method `this`-lowering, which is the deep #2659/#2664-family
  `__current_this` / member-dispatch machinery (sd-2038's domain) — escalate.

This residual bottoms out in the deep `__current_this` machinery per the
hand-off threshold; the string-hint + @@toPrimitive half is a clean, shippable
partial.
