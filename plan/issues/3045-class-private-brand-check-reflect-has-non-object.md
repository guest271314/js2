---
id: 3045
title: "class private-element brand check emits Reflect.has on a non-object receiver (private methods/generators/static-private)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
model: fable
architect_spec: done
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

## Implementation Plan (arch, 2026-07-05) — Bug 2 only (Bug 1 has LANDED)

**Bug 1 is on main** (`src/codegen/statements/variables.ts:709-741` now routes
class-expression initializers through the materialize-and-store path — the old
`if (isClassExpression) continue;` skip is gone). This spec is **Bug 2 only**:
class-expression ctor/method bodies do not capture the enclosing function's
scope. Re-scoped `status: ready` (was `blocked` on Bug 1).

### Root cause (traced to the exact asymmetry)

Class **declarations** and class **expressions** nested in a function are BOTH
deferred at collection time (`src/codegen/declarations.ts`:
decl → `ctx.deferredClassBodies.add(stmt.name.text)` at line 4826-4829;
`var C = class{}` → `ctx.deferredClassBodies.add(decl.name.text)` at 4852-4854).
The divergence is at **compile time**:

- A deferred class **declaration** in statement position is re-reached by
  `compileStatement` → `ts.isClassDeclaration(stmt)` →
  `compileNestedClassDeclaration` (`src/codegen/statements.ts:272-273`). That
  function (`src/codegen/statements/nested-declarations.ts:83`) runs
  **`promoteAccessorCapturesToGlobals(ctx, fctx, member.body, paramInits)` for
  every ctor/method/accessor** (nested-declarations.ts:126-139) **against the live
  enclosing `fctx`**, THEN compiles the bodies (`compileClassBodies`, line 148).
  Promotion of the captured enclosing locals to module globals is what lets the
  separately-compiled ctor/method functions read/write the outer scope.

- A class **expression** binding (`var C = class{}`) is a `ts.VariableStatement`,
  **not** a `ts.isClassDeclaration` — so `compileStatement` never routes it to
  `compileNestedClassDeclaration`. It goes through the variable path
  (`statements/variables.ts`, the Bug-1 materialization), which stores the
  BINDING value but **never calls `promoteAccessorCapturesToGlobals`** and never
  compiles the class BODIES in-scope. The deferred entry for `C` is therefore
  compiled (if at all) WITHOUT the enclosing-scope capture promotion → ctor/method
  reads of enclosing locals resolve to null / stale globals, and writes are
  dropped. `decl-ctor-closure` (declaration) works; `expr-ctor-closure`
  (expression) does not — exactly dev-3047's finding.

### The fix

When `compileStatement` compiles a `VariableStatement` (or the variable path in
`statements/variables.ts`) whose declarator initializer is a
`ts.ClassExpression` **and we are inside a function** (enclosing `fctx` present /
`ctx.deferredClassBodies` holds the synthetic name), run the **class-expression
analog of `compileNestedClassDeclaration`** at that point, BEFORE/around the
Bug-1 binding materialization:

1. Resolve the synthetic class name: `ctx.anonClassExprNames.get(classExpr)`
   (set in `declarations.ts:3394`) — the same key `deferredClassBodies` and
   `compileClassBodies(ctx, classExpr, funcByName, syntheticName)` use.
2. For each `ctor` / `method` / `get`/`set` accessor member of the class
   expression, call `promoteAccessorCapturesToGlobals(ctx, fctx, member.body,
   paramInits)` with `paramInits = member.parameters.map(p => p.initializer)
   .filter(Boolean)` — **byte-for-byte the loop at
   nested-declarations.ts:126-139**. `fctx` is the enclosing function, whose
   locals are live at this statement.
3. Compile the class bodies in-scope: `compileClassBodies(ctx, classExpr,
   funcByName, syntheticName)` (funcByName rebuilt as at nested-declarations.ts:
   142-145), then `ctx.deferredClassBodies.delete(syntheticName)`.

**Cleanest implementation:** generalise `compileNestedClassDeclaration` to accept
`ts.ClassDeclaration | ts.ClassExpression` + an explicit `syntheticName` (its
callee `compileClassBodies` ALREADY accepts the union type and a syntheticName —
class-bodies.ts:1477), and invoke it from the class-expression variable path. The
`extendsReferencesClassName` TDZ guard (nested-declarations.ts:62) is
declaration-shaped; guard it on `decl.name` presence for the anonymous-expression
case.

### Regression risk — #779a index-shift machinery (the reason this is `hard`)

`promoteAccessorCapturesToGlobals` promotes captures to **module globals**, which
adds globals and can add late imports → **shifts function/global indices**. Two
guards, both already present but must be preserved for the new call site:

1. `compileClassBodies` registers the enclosing func on
   `ctx.funcStack`/`ctx.parentBodiesStack` (class-bodies.ts:1503-1507) so the
   enclosing body's already-emitted `global.get`/`global.set` are shifted with the
   maps — this fires for the expression path too (same function). Confirm the
   Bug-1 binding-store instructions emitted into `fctx.body` (variables.ts:764-768)
   are in the shift set: run the promotion+bodies compile at the SAME point they
   are for declarations relative to the enclosing body edits — i.e. do the capture
   promotion+body compile at the class-expression statement, so any global added
   shifts the enclosing body that was emitted BEFORE this statement, exactly as the
   declaration path relies on.
2. Ordering vs the Bug-1 materialization: the binding store (`local.tee` /
   `global.set` at variables.ts:764-768) reads the class ctor **value**. Decide
   whether promotion+bodies must run before or after that store; declarations have
   no binding store so this is the novel interaction — pick the order that keeps
   `emitLazyClassObjectGet` (variables.ts:736) resolving to the same singleton the
   ctor/method `this`/`constructor` uses, and that keeps the index-shift set
   consistent. This is the silently-wrong-code-risk knob — validate with the WAT
   diff (decl-ctor-closure vs expr-ctor-closure should converge).

### Scope note — subsumes two pre-existing failures

dev-3047: this also fixes the pre-existing `instanceof` / `extends`-a-class-
expression failures (a class expression used as an `extends` heritage or
`instanceof` RHS whose body captures enclosing scope). Add coverage for those.

### Verification plan

1. `.tmp/` repro mirroring the 8 harvested files: `function test(){ var seen;
   function hasProp(o,k){ seen = k; return k in o; } var C = class { m(){ return
   hasProp(this, 'x'); } }; ... }` — assert the ctor/method's call to the
   enclosing `hasProp` gets correct args AND its write to the enclosing `seen`
   propagates (main: wrong args / dropped write).
2. The 8 files: `prod-private-{method,async-method,async-generator,generator,
   method-initialize-order}.js`, `fields-multiple-definitions-static-private-
   methods-proxy.js`, `static-private-{methods,fields}-proxy-default-handler-
   throws.js` (all wrap the body in `export function test()` → nested class expr).
3. `tests/issue-3045.test.ts` (Bug-1's 9 cases) stays green; add expr-ctor-closure
   / expr-method-closure cases.
4. Regression: the class vitest suites and the `−471` non-capturing-class-expr
   shapes from PR #2335 (declarations.ts:4839-4840 comment) — non-capturing class
   expressions must stay eager/unchanged.
5. Full `merge_group` — class-expression scope capture is broad; standalone floor
   green.
