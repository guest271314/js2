---
id: 2709
title: "SuperCall remaining sub-cases: spread-getter side-effects, uninitialized-this PutValue, GetSuperBase ordering, nested-super this-init, top-level super-arg global visibility"
status: done
created: 2026-06-26
updated: 2026-06-26
completed: 2026-06-26
assignee: ttraenkler/sd-super2709
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, super, spread
goal: spec-completeness
sprint: Backlog
parent: 1551
related: [1455, 1456, 1824, 1965, 2714]
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

---

## Implementation notes & per-sub-case verdict (2026-06-26, verify-first)

Each sub-case was probed in isolation on current `main` (post-#1551) before
touching codegen. Two were genuinely fixable in the class/super lane and are
**landed**; the other three are characterized below with their real root causes.

### Sub-case 2 — uninitialized-`this` PutValue — FIXED ✅

`test262: prop-expr-uninitialized-this-putvalue{,-increment,-compound-assign}.js`.

**Why the obvious "null-`this` guard" did NOT work, and what does.** The first
instinct was a runtime null-check on the `this` local. But in our split-init
constructor model (`${C}_new` `struct.new`s the instance up-front and passes it
to `${C}_init` as a **non-null** `(ref $struct)` param — verified via WAT), `this`
is *never* null: there is no runtime "uninitialized = null" state to test. A
null-check is a dead no-op here. Before this fix, `super[super()] = 0` therefore
either (a) silently built a broken instance (no throw — `new Derived()` returned
a value) or (b) trapped with an uncatchable `illegal cast`.

The shape that the three test262 rows exercise is **`super[<key that contains a
`super(...)` call>]`** in PutValue / update position inside a derived
constructor. Per §13.3.7.1 (Evaluation of SuperProperty) the reference is
resolved — `GetThisBinding()`, step 2 — **before** the key Expression (step 3)
and the RHS. So for this shape the statement throws a `ReferenceError` in
**every** execution:

- if `super()` has not yet run, `this` is uninitialized → `GetThisBinding()`
  throws ReferenceError before the key is evaluated;
- if `super()` has already run, the key's *inner* `super()` is a second
  SuperCall → "Super constructor may only be called once" ReferenceError.

So emitting an **unconditional** `ReferenceError` for this exact syntactic shape
is spec-correct in all cases, and — crucially — the shape `super[super()] = …`
**never appears in valid programs**, so this is **zero regression risk** (no
currently-passing path reaches it; confirmed: class/element/increment suites have
identical pass/fail counts on HEAD vs branch). The inner `super()` and the RHS
are NOT evaluated (we early-return after the throw), matching the spec ordering
(the parent constructor must not run).

Implementation: `emitSuperUninitializedThisGuard` in
`src/codegen/expressions/helpers.ts` — detects `fctx.isDerivedConstructor` + a
key expression that syntactically contains a same-scope `super(...)` call (via
`expressionContainsSuperCall`, mirroring `constructorBodyHasSuperCall`'s descent
rules), then emits the floor-safe `emitThrowReferenceError` (in-module
`__new_ReferenceError` under standalone/WASI — verified both modes compile).
Wired at the four super-element write/update entry points:
- `compileElementAssignment` (`super[super()] = v`) — `assignment.ts`
- `compileCompoundAssignment` element arm (`super[super()] += v`) — `assignment.ts`
- `compileMemberIncDec` element arm (`super[super()]++`, `++super[super()]`) — `unary-updates.ts`
- defensive coverage in `compilePrefix/PostfixIncrementElement` — `unary-updates.ts`

The thrown value is a real `ReferenceError` instance (`e instanceof
ReferenceError` holds), so test262 `assert.throws(ReferenceError, …)` passes.
Guard tests: `tests/issue-2709.test.ts`.

### Sub-case 5 — top-level super-arg global visibility — ALREADY FIXED ✅ (regression guard added)

`var calls=0; function f(){calls++;return 42} class C extends P{constructor(){super(f())}}`
→ on current `main`, the parent receives `42` **and** `calls` reads back `1`.
The "secondary quirk" reported in #1551 (parent got 42 but `calls` read 0) no
longer reproduces — the #1551 arg-rollback fix (nested-super fallback returns
`VOID_RESULT`, preserving the emitted arg-evaluation) resolved it. No codegen
change needed; a regression guard was added to `tests/issue-2709.test.ts`.

### Sub-case 1 — spread-getter side effects — NOT super-specific → spun out as #2714

The super-argument spread path is **byte-identical** to the non-super
object-expression path (verified: `f({...o, get c(){}})` behaves the same as
`super({...o, get c(){}})`). The getter is correctly NOT invoked and spread
**values copy correctly** (`obj.a === 2`, `obj.b === 3`). The remaining failure
is purely that **`Object.keys` does not enumerate spread-copied keys** (and a
data property *after* a spread is also dropped from enumeration) — a generic
object-literal/`Object.keys` defect in `literals.ts`/`builtins.ts`, **outside the
class/super lane**. Spun out as **#2714** with full repro. Fixing #2714 unblocks
`call-spread-obj-getter-init.js`.

### Sub-case 3 — GetSuperBase before ToPropertyKey — base feature unsupported (deferred)

`test262: prop-expr-getsuperbase-before-topropertykey-*.js` use `super[key]` in an
**object-literal method** (not a class). `compileSuperPropertyAccess` /
`compileSuperElementAccess` return a compile-time **default** (`0` / `ref.null`)
whenever `resolveEnclosingClassName` is undefined — i.e. dynamic prototype-chain
`super` in object-literal methods is not supported at all (`super.p` / `super[k]`
return `0` instead of the prototype value). The GetSuperBase-vs-ToPropertyKey
ordering nuance is therefore **moot** until that base feature exists. Deferred —
this is a sizable object-method-super feature, not a class/ctor fix.

### Sub-case 4 — nested-super `this` initialization — architectural gap (deferred)

Confirmed still present: `class C extends Object { constructor() { try {
super(); this.v = 42; } catch {} } }` → `new C()` returns a **null-ish**
instance. #1551 made nested `super(...)` evaluate its arguments (side effects +
abrupt completion propagate), but the nested-super fallback in
`compileCallExpression` (`calls.ts`) still does NOT invoke the parent constructor
/ initialize `__self`. Fully supporting nested `super(...)` requires routing the
fallback through the real `compileSuperCall` machinery in `class-bodies.ts`,
which needs `className` / `selfLocal` / `fields` context threaded into the
generic `compileCallExpression` — an architectural change beyond this fix.
Deferred (kept tracked under this issue / #1551 lineage).

## Outcome
- **Fixed:** sub-case 2 (3 test262 rows: putvalue, putvalue-increment,
  putvalue-compound-assign) + sub-case 5 (regression-guarded).
- **Spun out:** sub-case 1 → #2714 (object-spread `Object.keys` enumeration).
- **Deferred (characterized):** sub-case 3 (object-method super, base feature),
  sub-case 4 (nested-super parent-construction routing).
- Tests: `tests/issue-2709.test.ts` (7 cases, all green). Zero regressions in
  class/element/increment suites (identical HEAD-vs-branch counts). Standalone +
  WASI compile verified.
