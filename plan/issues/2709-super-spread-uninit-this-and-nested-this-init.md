---
id: 2709
title: "SuperCall remaining sub-cases: spread-getter side-effects, uninitialized-this PutValue, GetSuperBase ordering, nested-super this-init, top-level super-arg global visibility"
status: ready
created: 2026-06-26
updated: 2026-06-26
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, super, spread
goal: spec-completeness
sprint: Backlog
parent: 1551
related: [1455, 1456, 1824, 1965]
---
# #2709 — SuperCall remaining sub-cases (carved out of #1551)

#1551 was reframed (verified 2026-06-26) around a single concrete root cause —
`super(...)` **inside a `try`/control-flow region** had its argument evaluation
*rolled back* by the #1919 speculative wrapper, so a throwing super-arg escaped
the enclosing try-region. That has been fixed (the nested-super fallback in
`compileCallExpression` now returns `VOID_RESULT` instead of `null`, so
`compileExpressionBody` preserves the emitted arg-evaluation instead of
truncating them). See `tests/issue-1551.test.ts` and the commit on
`issue-1551-super-try-region`.

This follow-up tracks the remaining super sub-cases that #1551's original spec
listed but that the abrupt-completion fix does **not** address. They are
independent code paths.

## Sub-cases

### 1. Spread argument getter side-effects (`call-spread-*`, ~25 test262 rows)
`super({...o, get c() { executedGetter = true; }})` — the object spread must use
CopyDataProperties semantics: own-enumerable keys of `o` are read, and the inline
`get c()` is installed as an accessor descriptor **without being invoked**.
Verify the spread path used for super arguments matches `compileObjectExpression`
(the non-super position), reusing `__copy_data_properties`. See #1551 step 4.

### 2. Uninitialized-`this` PutValue (`prop-expr-uninitialized-this-putvalue*`, ~6 rows)
`class Derived extends Base { constructor() { super[super()] = 0; } }` must throw
`ReferenceError` (because `this` is uninitialized at the `super[expr]` reference
resolution) **before** evaluating the inner `super()` or the RHS. Emit the
uninitialized-`this` guard at the top of `compileSuperProperty` (PutValue
context) before the index expression is evaluated. See #1551 step 2.

### 3. `GetSuperBase` before `ToPropertyKey` (`prop-expr-getsuperbase-before-*`, 2 rows)
§13.3.7.3: compute `GetSuperBase()` (≈ `GetPrototypeOf(this)`) **before**
`ToPropertyKey(propertyNameValue)`. Swap the two emission blocks in
`compileSuperProperty`. See #1551 step 3.

### 4. Nested-super `this` initialization (the best-effort gap)
The #1551 fix made nested `super(...)` **evaluate its arguments** (side effects +
abrupt completion now propagate), but the nested-super fallback still does NOT
actually invoke the parent constructor / initialize `this`. A non-throwing
`class C extends Object { constructor() { try { super(x); } catch {} } }` leaves
`__self` null and returns a null-ish instance. To fully support `super(...)`
inside control flow, the fallback needs to perform the real parent
construction (route through the `compileSuperCall` machinery in
`class-bodies.ts`, which needs `className` / `selfLocal` / `fields` context that
is not currently threaded into the generic `compileCallExpression`).

### 5. Top-level super-arg global-visibility quirk (the "secondary quirk" from #1551)
**Needs re-verification.** Reported in #1551: for
`var calls = 0; function f(){ calls++; return 42; } class C extends P {
constructor(){ super(f()); } }`, the parent received `42` but the module-global
`calls` read back `0`. This is the **top-level** super path
(`compileSuperCall` split-init `${C}_new` → `return_call ${C}_init`), distinct
from the nested-super fallback fixed in #1551. A WAT dump of `C_init` for that
shape shows the super-arg call interleaved with the parent-init call in a way
worth auditing for argument ordering and global write-back. Re-probe on current
main (the #1551 arg-rollback fix may have shifted behavior) before implementing.

## Acceptance criteria
- `test/language/expressions/super/call-spread-obj-getter-init.js` passes.
- `test/language/expressions/super/prop-expr-uninitialized-this-putvalue.js` and
  `…-increment.js` pass.
- `test/language/expressions/super/prop-expr-getsuperbase-before-topropertykey-getvalue.js`
  passes.
- `expressions/super/` `assertion_fail` count reduces (target ≥ 40 once spread +
  uninit-this land).
- Nested `super(...)` in a non-throwing `try` produces a correctly-initialized
  instance (sub-case 4).

## Files to inspect
- `src/codegen/expressions/new-super.ts` — `compileSuperProperty`, super-element.
- `src/codegen/class-bodies.ts` — `compileSuperCall`, split-init constructor.
- `src/codegen/expressions/calls.ts` — nested-super fallback (~:13024).
- `src/codegen/expressions/object.ts` — object-spread / CopyDataProperties.
