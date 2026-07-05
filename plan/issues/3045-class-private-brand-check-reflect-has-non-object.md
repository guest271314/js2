---
id: 3045
title: "class private-element brand check emits Reflect.has on a non-object receiver (private methods/generators/static-private)"
status: blocked
sprint: current
priority: medium
horizon: m
feasibility: hard
created: 2026-07-05
task_type: bugfix
area: codegen, runtime
language_feature: class-private-methods
es_edition: 6
goal: spec-completeness
parent: 3022
related: [3022]
---

# #3045 — class private brand-check `Reflect.has` on non-object

Split from the #3022 umbrella (the "called on non-object" cluster — the
`Reflect.has called on non-object` sub-group). **Developer-scoped.**

## Root cause

The private-element **brand check** (used for private methods/accessors — the
`#m in obj` membership test and the implicit brand check on private-method
access) lowers to an internal `Reflect.has(receiver, key)`. In the private-
method / private-generator / static-private paths the `receiver` reaching that
`Reflect.has` is a **non-object** in our representation (undefined / an unboxed
value), so the runtime helper throws `Reflect.has called on non-object` instead
of performing the brand check. `built-ins`/`language` class tests that install
private *methods* (not just fields) hit this.

## Failing files (8)

`prod-private-async-method.js`, `prod-private-async-generator.js`,
`prod-private-method.js`, `prod-private-method-initialize-order.js`,
`fields-multiple-definitions-static-private-methods-proxy.js`,
`prod-private-generator.js`,
`static-private-methods-proxy-default-handler-throws.js`,
`static-private-fields-proxy-default-handler-throws.js`.

## Layer to fix

`src/codegen` private-element brand-check lowering — ensure the receiver is the
boxed object (or emit the brand check without routing through
`Reflect.has` on a non-object). Check how private *methods* differ from private
*fields* (fields work; methods don't) in the brand-check emit path.

## Acceptance

- The listed private-method/generator class tests pass; no regression in
  private-field tests. Scope: **DEV**.

## Investigation (dev-3047, 2026-07-05)

The harvest's framing ("private brand check emits Reflect.has on a non-object")
was a symptom, not the root cause. Traced to the WAT: the failing tests use a
**class expression** (`var C = class { ... }`), and this bucket is actually
**two independent class-expression bugs** — neither private-method-specific.

### Bug 1 — class-expression binding not materialized (FIXED, partial PR)

`src/codegen/statements/variables.ts` **skipped** the class-expression
initializer (`if (isClassExpression(decl.initializer)) continue;` — "already
handled as class declaration"). So the (pre-hoisted, instance-struct-typed) local
`$C` was declared but **never stored**. Reading `C` as an rvalue read an
uninitialized null local; coercing null to externref for a host import threw
`Reflect.has called on non-object` / `Cannot convert undefined or null to
object`. Confirmed decl-vs-expr in the WAT (decl lazily materialises `$__class_C`
and passes it; expr did `local.get $C` on an unstored null local).

**Fix**: route class-expression initializers through the same "compile
initializer → re-type the pre-hoisted slot to the closure type → store" path
already used for arrow/function-expression bindings. `new C()` is unaffected (it
resolves the class statically via `classSet`, not the binding value).
Validated: Reflect.has / hasOwnProperty.call / pass-to-fn on a class-expression
value now work; new/method/ctor-arg/static/two-instance all still correct;
regression-free on the class vitest suites (18=18, all pre-broken by an
unrelated `string_constants` harness issue) and on the pre-existing
`instanceof` / `extends`-a-class-expr failures (fail-before == fail-after).
Tests: `tests/issue-3045.test.ts` (9 cases).

### Bug 2 — class-expression method/ctor closure capture (DEEP — blocks the 8 files)

Even with Bug 1 fixed, the 8 harvested tests still fail: after wrapping, the test
body sits inside `export function test()`, so `var C = class { ... }` is a class
expression **nested in a function**, and its constructor calls a `test()`-local
helper (`hasProp`). **Class-expression constructors/methods do NOT capture the
enclosing function's scope**, while class **declarations** do
(`decl-ctor-closure` writes the outer `let` correctly; `expr-ctor-closure` does
not — the ctor's calls to enclosing-local functions get wrong args/returns and
its writes to enclosing locals are dropped). This is tied to the **#779a
captured-global machinery** (`funcStack`/`parentBodiesStack` shift-tracking in
`class-bodies.ts`) that the class-declaration path registers on but the
class-expression path bypasses. Extending that machinery to class expressions is
**senior/architectural depth**, high index-shift regression risk.

### Recommendation

Split: Bug 1 lands as a standalone partial fix (this PR — does NOT close #3045).
Re-scope #3045 (or a new senior issue) to Bug 2 (class-expression enclosing-scope
capture), which also subsumes the pre-existing `instanceof` / `extends`-a-class-
expression failures. `feasibility: hard`, route to senior/Fable.
