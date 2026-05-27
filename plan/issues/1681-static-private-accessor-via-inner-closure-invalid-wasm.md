---
id: 1681
title: "Static private accessor reached through inner closure emits invalid Wasm (extern.convert_any) / infinite recursion (~10 fails)"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: class, class-static-methods-private, private-accessors, closures
goal: spec-completeness
sprint: Backlog
related: [1680, 1365, 1051, 1226]
test262_fail: 10
---
# #1681 — Static private accessor via inner closure → invalid Wasm / infinite recursion

## Problem

Accessing a **static private getter/setter** through `this.#x` from **inside a
nested closure** (arrow function, inner function expression, or inner class)
produces either invalid Wasm at instantiation or unbounded recursion. The
same accessor accessed directly from the static method body compiles, so the
bug is in how the closure-captured receiver + private-name accessor trampoline
is lowered, not in the accessor definition itself.

Found while investigating `language/class/elements` residual test262 failures
(task #108). This is the RUNFAIL portion of the static-private-accessor
cluster; the ASSERTFAIL/dispatch portion is tracked separately in #1680.

### Minimal reproduction

```js
class C {
  static get #f() {
    return 'Test262';
  }
  static access() {
    const arrowFunction = () => {
      return this.#f;        // static private getter reached via captured `this`
    };
    return arrowFunction();
  }
}
// C.access() === 'Test262'
```

Variants that fail the same way:
- inner **arrow** function (above) — `WebAssembly.instantiate(): Compiling
  function ..."test" failed: extern.convert_any[...] expected ...`
- inner **function** expression — `RangeError: Maximum call stack size
  exceeded` (the accessor trampoline appears to recurse into itself).
- inner **class** static method reaching the outer class private accessor.

## Failure signature (from probe, current main)

Of 74 `static.*private.*(getter|setter)` tests in
`language/{statements,expressions}/class/elements`:
- PASS 39, ASSERTFAIL 21 (mostly #1680 dispatch), **RUNFAIL 10**, skip 4.

RUNFAIL buckets (the scope of THIS issue):
- `5` `extern.convert_any` invalid Wasm — `static-private-{getter,setter}-access-on-inner-{arrow-function,function,class}.js`
- `2` `Maximum call stack size exceeded` — `static-private-getter-access-on-inner-function.js`, `...-setter-...`
- `1` `C_getAccess failed: extern.convert_any` — `get-access-of-missing-private-static-getter.js`

## Suspected root cause

When a static private accessor is invoked from a closure, the receiver
(`this` for a static member = the constructor object) is captured into the
closure environment as an `externref`/`anyref`, but the accessor-call
trampoline expects the concrete class-constructor struct ref. The emitted
`extern.convert_any` (or the missing cast) mismatches the accessor's declared
parameter/receiver type, failing Wasm validation. The inner-function recursion
case suggests the private-name dispatch resolves the accessor call back to the
enclosing accessor rather than the backing function — i.e. the closure path
loses the `<Class>_get_<field>` / `<Class>_set_<field>` funcIdx binding and
re-enters the getter.

Likely the same dispatch sites referenced in #1680
(`src/codegen/expressions/assignment.ts` for set, the member-access read path
for get, and `classifyPrivateMember` in
`src/codegen/expressions/helpers.ts`), but specifically where the receiver
originates from a captured closure variable rather than the current
function's `this` local. Compare against the public-accessor closure path,
which compiles.

## Acceptance criteria

1. The minimal reproduction compiles to valid Wasm and `C.access()` returns
   `'Test262'`.
2. The 10 RUNFAIL `static-private-*-access-on-inner-*` /
   `get-access-of-missing-private-static-getter` tests no longer produce
   invalid Wasm or stack overflow (they should PASS or, for the
   missing-getter case, throw the spec TypeError).
3. Focused equivalence test `tests/issue-1681.test.ts`: static private getter
   read via inner arrow, via inner function, and via inner class static method.
4. No regression in private-field / private-method test262 buckets, and no
   regression to the #1680 dispatch fix.

## Reproduce

```bash
# file list
grep -E 'static.*(getter|setter)|(getter|setter).*static' \
  <(find test262/test/language/{statements,expressions}/class/elements -name '*.js' \
    | sed 's#^test262/##') | grep -i privat > .tmp/static-acc.txt
npx tsx .tmp/probe-class108.mts .tmp/static-acc.txt   # probe harness from task #108
```

## Investigation 2026-05-27 (dev-1659-ci-equivalence)

Probe of the 12 inner-closure static-private getter/setter tests on current main:
**6 RUNFAIL + 6 ASSERTFAIL, 0 PASS.** Findings:

1. **The simple value read already works on baseline.** `C.access()` for the
   inner-arrow *getter* returns `'Test262'` correctly on unmodified main (both
   module-top-level and nested-in-function class). The arrow's `this.#f` already
   hits the static-context dispatch in `compilePropertyAccess` because an arrow
   has no `this` local (`localMap.get("this") === undefined`). So criterion 1 of
   the minimal repro is **NOT actually broken** on main.

2. **The dominant failure is the SECOND assertion**, `assert.throws(TypeError,
   () => C.access.call({}))` — the static-private **brand check**. The static
   getter ignores `this` (module-global backing via `emitGetterCallWithDummy`),
   so calling `access` with a foreign receiver `{}` still returns the value
   instead of throwing TypeError. This is the same brand-check semantics tracked
   in **#1680** and is the ASSERTFAIL bucket. Fixing it requires threading the
   real receiver through the static accessor and brand-testing it — a shared
   design with #1680, not a localized dispatch tweak.

3. **The setter RUNFAIL (`extern.convert_any` invalid Wasm) only reproduces
   under the full test262 harness**, not in any minimal standalone repro
   (verified: setter-only closure write, class-in-function, `.call({})`,
   try/catch, assert shims — each in isolation compiles & runs). The trigger is
   a harness-specific codegen interaction at function `"test"`; needs a focused
   bisect of the wrapped source.

4. **A naive fix is a regression.** Marking the accessor body `isStaticContext`
   in `class-bodies.ts` (so `this.<prop>` inside the accessor routes through the
   static-global path) introduces **infinite recursion** on the
   already-working arrow getter (`Maximum call stack size exceeded`). Broadening
   the `compilePropertyAccess` `this`-guard with `|| fctx.isStaticContext` is
   net-neutral on test262 (every affected test still fails on the brand-check
   assertion) but harmless. Both changes were reverted.

**Recommendation:** carve/spec this jointly with **#1680** — the load-bearing
fix is the static-private **brand check** (receiver threading), not the
closure-receiver lowering. The closure value-read path is already correct on
main. Suggest re-scoping #1681 to "setter-under-harness RUNFAIL bisect" +
folding the brand-check ASSERTFAIL into #1680.
