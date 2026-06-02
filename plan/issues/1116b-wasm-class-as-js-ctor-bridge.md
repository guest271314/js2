---
id: 1116b
title: "Promise subclass: Wasm-compiled class extends Promise must be a valid JS constructor (Wasm-class-as-JS-ctor bridge)"
status: done
created: 2026-05-20
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: classes, Promise, subclassing
goal: spec-completeness
sprint: 55
parent: 1116
related: [1455, 1326, 1366a, 1366b, 1382]
test262_est: 65
note: "v2 spec (2026-05-23, arch). The 2026-05-21 plan below referenced
  fictional symbols (_buildJsConstructorBridge, __register_constructor,
  compileClassDeclaration) that do NOT exist in the tree. The authoritative
  plan is '## Implementation Plan (v2)' — written against verified current
  line refs on origin/main e114fe378. PR #436 (ctx-non-object TypeError)
  and #379 (combinators) have landed; this builds on them."
---
# #1116b — Wasm-class-as-JS-ctor bridge for Promise subclasses

## Problem

~61 tests in `built-ins/Promise/` fail with `[object Object] is not a constructor`
when user-defined Wasm-compiled classes extend `Promise`:

```ts
class MyPromise extends Promise {
  constructor(executor: (resolve: any, reject: any) => void) {
    super(executor);
  }
}
Promise.all.call(MyPromise, [p1, p2]); // Should create a MyPromise, not throw
```

Root cause: `Promise.all/race/allSettled/any` use `SpeciesConstructor` (§7.3.24)
which calls the `@@species` symbol → returns the Wasm-compiled class → JS engine
tries to call it as a constructor → Wasm exports are not JS-callable constructors.

The same root cause affects:
- `Promise.all.call(SubClass, iter)` — ~61 tests
- `ctx-ctor` pattern — ~4 tests  
- Any promise combinator that respects `@@species`

## Root cause (from #1116 investigation, senior-dev-1326c, 2026-05-20)

Wasm-compiled classes are represented as GC structs with a `$constructor` field
holding a `funcref`. When the JS engine tries to use them as constructors via
`new SubClass(executor)`, the call fails because Wasm exported functions don't
carry the `[[Construct]]` internal method that JS constructors require.

## Related work

- #1382 (Wasm closures not JS-callable) — adjacent problem; closed with a bridge
  pattern. #1116b may reuse the same bridge infrastructure.
- #1455 (subclassing builtins — instanceof + prototype chain) — companion issue

## Implementation approach (needs architect spec)

Options:
1. **Wrapper function export**: For each class that extends a built-in, emit a
   JS-callable wrapper exported function that calls `$new_MyClass(executor)`.
   Register via `__register_constructor` host import.
2. **`@@species` stub**: Override `Symbol.species` on the compiled class to
   return a JS-native wrapper instead of the Wasm struct. The wrapper holds
   a reference to the Wasm new-object function.
3. **Runtime bridge at Promise.all site**: In the host runtime, detect when
   `thisArg[Symbol.species]` is a non-constructible Wasm export and substitute
   a thin proxy.

Option 1 is the most spec-compliant but requires tracking which classes extend
builtins at compile time.

## Acceptance criteria

- `Promise.all.call(MyPromise, [p1, p2])` returns a `MyPromise` instance
- `Promise.race.call(MyPromise, [...])` same
- Tests in `built-ins/Promise/all/ctx-ctor.js` (and sibling files) pass
- No regression in existing Promise tests

## Notes

Discovered during scoped fix of #1116 (ctx-non-object cluster). The ~4
`ctx-non-object` tests were fixed in PR #436. This is the remaining
architectural work.

## Implementation Plan (v2) — VERIFIED AUTHORITATIVE

> Author: architect, 2026-05-23, against `origin/main` @ `e114fe378`.
> **This supersedes the 2026-05-21 plan** (preserved verbatim under
> "## Implementation Plan (v1 — STALE, do not follow)" further below).
> The v1 plan referenced `_buildJsConstructorBridge`,
> `__register_constructor`, `compileClassDeclaration`, and a sidecar
> `__jsConstructor` slot — **none of these exist in the tree**. Do not
> grep for them; you will waste time. Every file:line below was verified.

### Root cause (corrected)

A `class MyPromise extends Promise` is detected at
`src/codegen/class-bodies.ts:161` (`isHostConstructibleBuiltin("Promise")`
is true). The class is therefore:

1. Added to `ctx.classBuiltinParentMap` and `ctx.classExternrefBackedSet`
   (`class-bodies.ts:162-163`).
2. **Given NO `__class_<Name>` singleton global** — the registration at
   `class-bodies.ts:291` is explicitly skipped for
   `classBuiltinParentMap.has(className)` classes.
3. Its constructor `MyPromise_new` returns **externref** (a real host
   Promise produced by `__new_Promise(executor)`), not a `(ref $struct)`
   (`class-bodies.ts:351-354`).

So `MyPromise` *instances* are real host Promises — good. But the **class
identifier itself** is the problem:

- When the user writes `Promise.all.call(MyPromise, iter)`, codegen
  reaches the `.call` aggregator branch at
  `src/codegen/expressions/calls.ts:4067-4112`. It compiles
  `expr.arguments[0]` (`MyPromise`) to externref via
  `compileExpression(...)` at `calls.ts:4100`, then calls the
  `Promise_all` import with `(thisArg, iterable, directCall=0)`.
- `compileExpression` on the bare `MyPromise` identifier flows through
  `compileIdentifier` (`src/codegen/expressions/identifiers.ts:326`). The
  class-object-singleton path at `identifiers.ts:478-485` is **skipped**
  because there is no `classObjectGlobals` entry (point 2 above). The
  identifier therefore falls through to the generic
  funcref / `ref.null.extern` fallback → `thisArg` becomes `null` or an
  opaque value.
- At runtime, `_resolveCtor` (`src/runtime.ts:5557-5570`) returns
  `thisArg` unchanged for `directCall=0`, then
  `Promise.all.call(thisArg, …)` runs in the host. Since `thisArg` is not
  a JS constructor, V8 throws `[object Object] is not a constructor` (or
  `undefined is not a constructor`). That is the ~61-test failure cluster.

**The fix is to make `MyPromise`, when used as a value, resolve to a
real JS-callable constructor that (a) is `[[Construct]]`-able, (b) builds
a host Promise via `MyPromise_new`, and (c) carries `MyPromise.prototype`
so `result instanceof MyPromise` and species resolution work.**

### Approach — runtime-synthesized JS subclass keyed by class name

We do **not** need a funcref export or a `[[Construct]]` shim on a Wasm
function. The instance is *already* a host Promise. The only thing the
combinator needs is a JS constructor `C` such that `new C(executor)`
returns a Promise whose `[[Prototype]]` chains to `MyPromise.prototype`.
We synthesize that JS constructor in the runtime, on demand, keyed on the
class name, and hand it to the combinator as `thisArg`.

This reuses the existing externref-backed-builtin-subclass machinery
(#1366a/b) and the `extern_class new` resolver — no new struct fields, no
GC cycle risk, no funcref plumbing.

#### Codegen changes

**File: `src/codegen/expressions/calls.ts`** — the `.call` aggregator
branch at lines 4067-4112, AND the direct-call aggregator branch at
4059-4011 (for the `Sub.all(iter)` subclass-receiver case — see Edge case
E5).

Add a helper, `resolvePromiseSubclassThisArg(ctx, fctx, argExpr)`, called
in place of the bare `compileExpression(ctx, fctx, expr.arguments[0]!,
{ kind: "externref" })` at `calls.ts:4100`:

```typescript
// Returns true if it emitted a JS-constructor externref for argExpr;
// false if the caller should fall back to plain compileExpression.
function resolvePromiseSubclassThisArg(
  ctx: CodegenContext, fctx: FunctionContext, argExpr: ts.Expression,
): boolean {
  // Only fires for a bare identifier (or class-expr alias) that names a
  // class extending a host-constructible builtin Promise.
  let className: string | undefined;
  if (ts.isIdentifier(argExpr)) {
    const n = argExpr.text;
    className = ctx.classExprNameMap.get(n) ?? n;
  }
  if (
    className === undefined ||
    !ctx.classBuiltinParentMap.has(className) ||
    ctx.classBuiltinParentMap.get(className) !== "Promise"
  ) {
    return false;
  }
  // Emit: call __promise_subclass_ctor("<ClassName>") -> externref
  // (a host import that lazily synthesizes + caches a JS subclass of
  //  Promise whose prototype is wired to the class instance's proto).
  const importName = "__promise_subclass_ctor";
  let funcIdx =
    ctx.funcMap.get(importName) ??
    ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
  if (funcIdx === undefined) return false;
  // Push the class name as a host string constant (use the existing
  // string-literal emit helper so it works in both string backends).
  emitStringConstant(ctx, fctx, className); // see note below on the helper
  fctx.body.push({ op: "call", funcIdx });
  return true;
}
```

At `calls.ts:4100`, replace:

```typescript
compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
```

with:

```typescript
if (!resolvePromiseSubclassThisArg(ctx, fctx, expr.arguments[0]!)) {
  compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
}
```

**String-constant helper**: there is no single canonical
`emitStringConstant` — grep for how `className` strings are already
emitted to host imports. The simplest correct path is the same one
`extern_class new` intent uses: pass the name through the existing
host-string mechanism. If no reusable helper exists in `calls.ts`, prefer
passing the class **tag** (an i32, available via the
`BUILTIN_TYPE_TAGS`/`classTagMap` pattern) instead of a string, and have
the runtime keep an i32→className map populated at module init. **Confirm
the existing string-literal lowering before choosing**; do not invent a
new string ABI. (If string emission is awkward here, the i32-tag variant
is the recommended fallback — it sidesteps the dual string-backend
concern entirely.)

#### Runtime changes

**File: `src/runtime.ts`** — add a new host import handler in the same
block as the other `Promise_*` handlers (the `name === "Promise_all"`
region begins at line 5571; add `__promise_subclass_ctor` just before
it, after the `_resolveCtor`/`_toIterable` helpers at 5557).

```typescript
// (#1116b) Synthesize (and cache) a JS subclass of Promise for a
// Wasm-compiled `class MyPromise extends Promise`. The instance is
// already a real host Promise (built via __new_Promise); this JS
// constructor only needs to be [[Construct]]-able and carry a
// prototype so species + instanceof resolve. Keyed on class name.
const _promiseSubclassCtors = new Map<string, any>();
if (name === "__promise_subclass_ctor") {
  return (classNameRef: any): any => {
    const className = String(classNameRef);
    let C = _promiseSubclassCtors.get(className);
    if (C === undefined) {
      // A minimal spec-conforming Promise subclass. Promise.all et al.
      // call `new C(executor)` internally (NewPromiseCapability) and
      // resolve each element via `C.resolve`. Inheriting from Promise
      // gives correct [[Construct]], @@species (defaults to C via the
      // inherited Promise[@@species] getter returning `this`), and a
      // distinct .prototype for instanceof.
      C = class extends Promise {};
      // Give it the user-visible name for diagnostics / Function.name
      // assertions in some tests.
      try { Object.defineProperty(C, "name", { value: className, configurable: true }); } catch { /* non-fatal */ }
      _promiseSubclassCtors.set(className, C);
    }
    return C;
  };
}
```

> **Why a fresh `class extends Promise {}` and not the user's Wasm
> constructor body?** The Wasm `MyPromise_new` constructor body, for the
> common `constructor(executor){ super(executor); }` shape, does nothing
> but forward to `__new_Promise(executor)`. The host's
> `class extends Promise {}` with the default constructor is
> *observably identical* for every test262 species/ctx-ctor test (they
> assert the *kind* of object produced and that the combinator used the
> custom constructor's resolve/`@@species`, not user-side ctor side
> effects). Custom-constructor-side-effect cases are an explicit Edge
> case E4 below (deferred).

#### Import registration

`__promise_subclass_ctor` is registered on demand via `ensureLateImport`
(the codegen helper at `src/codegen/shared.ts:233`), exactly like the
other `Promise_*` imports. No change to `collectPromiseImports`
(`index.ts:4614`) is strictly required because the late-import path
covers it; **optionally** add detection there so the import is created
eagerly and avoids a late index shift (lower risk — prefer eager if the
detection is cheap to add next to the existing aggregator detection).

### Edge cases

- **E1 — `MyPromise.all(iter)` direct (no `.call`)**: a subclass
  *static* inherited from Promise. This reaches the direct-call
  aggregator branch (`calls.ts:3971`), which currently always pushes
  `ref.null.extern` for thisArg and `directCall=1`. To honor the
  subclass receiver, apply `resolvePromiseSubclassThisArg` to
  `propAccess.expression` (the `MyPromise` before `.all`) and, when it
  fires, emit `directCall=0` instead of `1`. Verify against
  `Promise/all/*` species tests that use `Sub.all(...)` form.
- **E2 — anonymous class** (`Promise.all.call(class extends Promise {},
  iter)`): `classExprNameMap` resolves the synthetic name
  (`__anonClass_N`). The runtime caches under that synthetic name — fine,
  it just needs to be stable per module. No special handling.
- **E3 — chained subclass** `class A extends Promise {}; class B extends
  A {}`: `classBuiltinParentMap.get("B")` is `"A"`, NOT `"Promise"`, so
  the guard above returns false and B falls through to the broken path.
  **Walk the parent chain**: in the guard, follow
  `ctx.classParentMap` (set at `class-bodies.ts:154`) up until you hit a
  class whose `classBuiltinParentMap` entry is `"Promise"`, or a builtin.
  Synthesize the JS subclass keyed on B's name so `result instanceof B`
  could later be made to hold; for the combinator's purposes a
  `class extends Promise {}` suffices. **Mark E3 as a stretch** — land
  the direct `extends Promise` case first; chained subclass is a small
  follow-up.
- **E4 — user constructor with observable side effects**
  (`constructor(ex){ this.tag = 1; super(ex); }`): the synthesized JS
  `class extends Promise {}` does not run the user body. **Deferred** —
  spec-conformance-wise the combinators only invoke the constructor as a
  NewPromiseCapability executor sink; test262 species tests do not assert
  user-ctor side effects on the combinator-built promise. Document as a
  known limitation. Real fix requires the funcref-export bridge from v1,
  which is out of scope for the ~61-test win.
- **E5 — `thisArg` is a *host* builtin** (`Promise.all.call(Promise,
  iter)` or `.call(SomeOtherBuiltin, …)`): guard returns false →
  unchanged behavior (passes the real builtin or triggers the existing
  TypeError path). No regression.
- **E6 — `thisArg` is a non-constructor / primitive / null**: guard
  returns false (not a Promise-subclass identifier) → existing PR #436
  TypeError path fires unchanged. **Do not break `ctx-non-object.js` /
  `ctx-non-ctor.js`.**
- **E7 — standalone (WASI) mode** (`isStandalonePromiseActive(ctx)`):
  there is no JS host, so `__promise_subclass_ctor` is unsatisfiable.
  The combinator `.call` path is JS-host-only today (the standalone
  branch at `calls.ts:4015-4041` only covers `Promise.resolve/reject`).
  Guard `resolvePromiseSubclassThisArg` with `if
  (isStandalonePromiseActive(ctx)) return false;` so standalone builds
  never emit the import. Standalone species support is out of scope
  (matches §7 of the S53 async-cluster spec — Promise subclassing
  deferred).

### Files touched

| File | Change |
|------|--------|
| `src/codegen/expressions/calls.ts` | add `resolvePromiseSubclassThisArg` helper; call it at the `.call` aggregator thisArg site (line ~4100) and the direct-call aggregator receiver site (line ~3990) |
| `src/runtime.ts` | add `__promise_subclass_ctor` host-import handler near line 5557 (before `Promise_all`) + module-scope `_promiseSubclassCtors` cache |
| `src/codegen/index.ts` *(optional)* | eager-register `__promise_subclass_ctor` in `collectPromiseImports` (line 4614) to avoid a late-import index shift |
| `tests/issue-1116b.test.ts` *(new)* | equivalence cases below |

### Test262 paths (verify after landing)

- `test/built-ins/Promise/all/ctx-ctor.js`
- `test/built-ins/Promise/all/species-*.js`
- `test/built-ins/Promise/race/species-*.js`, `race/ctx-ctor.js`
- `test/built-ins/Promise/allSettled/species-*.js`, `allSettled/ctx-ctor.js`
- `test/built-ins/Promise/any/species-*.js`, `any/ctx-ctor.js`
- `test/built-ins/Promise/resolve/resolve-from-*` (species via `C.resolve`)

**Acceptance**: ≥50 of the ~61 species/ctx-ctor Promise tests pass; zero
regression in existing `built-ins/Promise/*` (especially the PR #436
ctx-non-object TypeError tests) and zero regression in
`tests/equivalence.test.ts`.

### Equivalence test cases (`tests/issue-1116b.test.ts`)

1. **all + subclass via `.call`**:
   `class P extends Promise {}; Promise.all.call(P, [Promise.resolve(1), Promise.resolve(2)]).then(r => /* r is [1,2] */)`
   — assert it does NOT throw `is not a constructor` and resolves to `[1,2]`.
2. **race + subclass via `.call`**: same shape, expect first-settled.
3. **allSettled + subclass**: mixed resolve/reject, expect status objects.
4. **any + subclass**: expect first-fulfilled.
5. **negative guard (regression watch)**:
   `Promise.all.call(undefined, [])` still rejects/throws TypeError (PR #436);
   `Promise.all([Promise.resolve(1)])` (direct, no subclass) still works.

### Coordination / risk

- **#1116 (parent)** Promise-API v2 must land first or concurrently —
  this depends on the aggregator `.call` dispatch and the 3-arg
  `(thisArg, iterable, directCall)` import signature, both already on
  main (PR #379/#436). No textual conflict expected.
- **#1455 (builtin-subclass instanceof)**: shares
  `classExternrefBackedSet` / `classBuiltinParentMap` *reads* only; no
  writes. The synthesized JS subclass's prototype is independent of the
  #1455 instanceof path. Rebaseline species tests after both land — they
  interact (a combinator-built `MyPromise` should satisfy `x instanceof
  MyPromise`, which #1455's static-reasoning path handles separately).
- **Regression budget**: the guard is narrow (only fires for an
  identifier naming a `extends Promise` class) so blast radius is tiny.
  Hold to ≤10 regressions / no bucket >50 per dev-self-merge.
- **`Promise` shadowing**: the runtime synthesizes from the *intrinsic*
  `Promise` (lexical `Promise` in `runtime.ts`), not a user-shadowed
  global — correct by construction.

---

## Implementation Plan (v1 — STALE, do not follow)

> Preserved for provenance. References symbols that do not exist in the
> current tree (`_buildJsConstructorBridge`, `__register_constructor`,
> `compileClassDeclaration`, `__jsConstructor` sidecar slot). Use the v2
> plan above.

(Author: architect, 2026-05-21. Recommended approach: Option 1 +
Option 3 hybrid — emit a JS wrapper for builtin-subclass classes
AND keep a runtime bridge for generic species lookup.)

### Entry point

- **Compile time**: in `compileClassDeclaration` (search
  `src/codegen/declarations.ts`), detect when the class's
  `extends` clause resolves to a builtin (Promise, Array, Map, Set,
  Error, etc.) via the #1325 BUILTIN_TYPE_TAGS registry.
- **Runtime**: extend `_buildJsConstructorBridge` (existing per
  #1382) in `src/runtime.ts` to accept Wasm-class new-funcrefs.

### Data structure changes

1. New funcref export per builtin-subclass — naming convention
   `__class_ctor_<ClassName>`. Exported alongside the regular
   `$new_<ClassName>` Wasm function.

2. Class metadata struct (existing class object) gains a sidecar
   slot `__jsConstructor` holding the JS function wrapper.

3. `__register_constructor(name, fn)` host import (existing for
   #1382) reused; on instantiation, runtime calls `_attachJsCtor`
   to wire `$Symbol_species` and `[[Construct]]`.

### Algorithm

1. **Compile time** — for each class `C extends Builtin`:
   1. Mark `C` with `subclassesBuiltin = true` flag.
   2. Emit an exported wasm function `$new_C_export` that takes
      JS-side externref args, converts to wasm types, calls the
      generated `$new_C(...)`, and returns the result externref.
   3. After the import-shift pass, register the export via
      `__register_constructor`.

2. **Runtime** — `_attachJsCtor(className, newFn, prototype)`:
   1. Create a JS arrow `function MyClass(...args) { return
      newFn(...args); }` that throws if called without `new`.
   2. Set `MyClass.prototype = prototype` (the wasm-side prototype
      object).
   3. Define `MyClass[Symbol.species] = MyClass` so Promise
      combinators find it.
   4. Define `MyClass[Symbol.hasInstance]` to delegate to the
      builtin-tag check.

3. **Species lookup at host site**:
   1. When `Promise.all.call(MyClass, iter)` runs in JS, the host
      reads `MyClass[Symbol.species]` — which is now the JS
      wrapper function (step 2.3). Construction works.

4. **Fallback bridge** (Option 3) — for any externref that *looks*
   like a class but lacks `__jsConstructor`, the runtime's
   `__species_construct` import substitutes the JS wrapper from a
   lookup table keyed on class identity.

### Edge cases (v1)

- **`extends Promise` AND `extends Array` chain** — e.g.
  `class A extends Promise {}; class B extends A {}`. B's species
  must walk up to A, not Promise. The wrapper for B must be the
  child's wrapper.
- **Anonymous classes**: `Promise.all.call(class extends Promise {},
  iter)` — synthesize a unique name; register the wrapper.
- **`new.target` inside the constructor** — must equal the wrapper,
  not the wasm-side struct ref. Pass new.target as an extra
  parameter to the wasm ctor.
- **Calling `MyClass()` without `new`** — throws TypeError per spec
  for class constructors. The JS wrapper enforces.
- **Inheritance through `Reflect.construct`** —
  `Reflect.construct(Promise, args, MyClass)`. The wrapper's
  prototype chain must reflect this; lower `Reflect.construct` to
  use `Object.create(newTarget.prototype)` then dispatch the wasm
  ctor with the constructed `this`.
- **GC: cycle through ctor** — wrapper holds funcref → wasm holds
  classMeta → classMeta sidecar holds wrapper. Use a WeakMap
  keyed on classMeta for the JS wrapper to avoid retaining cycles.
- **Standalone mode (no JS host)** — no JS species exists. In
  standalone, `Promise.all.call` should still work because the
  combinator is now itself wasm-native (per #1116). The bridge is
  needed only for JS-host mode.

### Dependencies (v1)

- **#1116** — parent issue; this is the architectural follow-up.
- **#1382** — `_buildJsConstructorBridge` already exists; reuse.
- **#1325** — instanceof tag registry; needed to detect "extends
  builtin".
- **#1455** — instanceof + prototype-chain for builtin subclasses;
  complementary; coordinate the prototype attachment.

### Risks (v1)

- **Cycle leak**: JS-wrapper ↔ wasm class ref. Mitigate with the
  WeakMap pattern above.
- **`Promise` shadow**: if user code shadows the global `Promise`,
  the runtime's species detection must use the original Promise
  intrinsic, not the shadowed one.
- **Test262 baseline noise**: species tests interact with #1455
  in subtle ways; rebaseline after both land.
