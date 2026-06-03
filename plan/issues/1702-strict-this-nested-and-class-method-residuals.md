---
id: 1702
title: "Residual strict-mode `this` regressions: function-expression direct-call + nested fn-decl in class method"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
feasibility: medium
area: codegen
goal: core-semantics
sprint: 56
parent: 1636
---
# Residual strict-mode `this` (the #873 / #895 follow-up)

Follow-up to PR #895 / #1636-S1. A baseline-diff investigation found the pass
rate dropped 70.40% → 70.05% from PR #873 (#1636-S1, `ThisKeyword`
over-reading `__current_this`). PR #895 recovered most of it (→ 70.24%) but
**66 residual test262 regressions** persisted on main, all the SAME
strict-mode-`this` root cause #895 only partially fixed.

## The two failing shapes

### Shape 1 — `language/function-code/10.4.3-1-*-s` (34 cases)
In strict code, a function invoked with no receiver must see
`this === undefined`. The test262 runner (`wrapTest`) wraps the test body in
`export function test() { … }`, so a top-level `var f1 = function () { … }`
becomes a **local closure** inside `test()`:

```js
"use strict";
var f1 = function () {
    function f() { return typeof this; }
    return (f()==="undefined") && ((typeof this)==="undefined");
}
assert(f1());   // f1 itself: `this` must be undefined
```

The outer function-expression body carries `readsCurrentThis: true` (set on
EVERY lifted closure so a host `JSON.stringify` `toJSON`/replacer dispatch can
observe the installed receiver via `__current_this`). But for a **direct**
`f1()` call, `__current_this` is never installed — it holds its
`ref.null.extern` initial value. The pre-fix `global.get` surfaced raw JS
`null`, so `typeof this === "object"` and `this === undefined` was `false`.

### Shape 2 — `class/dstr/*meth-*ary-elision-iter` (32 cases)
Class method bodies are always strict. A nested `function inner() { … }`
declared inside a method was lifted with the method's `this` (the instance)
threaded in as a **capture param**, so `inner()` saw the instance instead of
the spec `undefined`. A `FunctionDeclaration` establishes its OWN `this`
binding (ECMA-262 §10.2.1.1 OrdinaryCallBindThis) — it never lexically
captures the enclosing `this` the way an arrow function does. The
array-destructuring-with-elision-over-iterator param was incidental; the
real corruption was the wrong `this` inside the strict method body.

## Root cause + fix

Two independent code paths feed the same wrong-`this` symptom:

1. **`src/codegen/expressions.ts`** — the `ThisKeyword` handler. The
   `readsCurrentThis` fallback (#1636-S1 / #895) did a raw
   `global.get __current_this`. A host receiver is always a **non-null**
   externref, so the null/non-null distinction cleanly separates the two reach
   paths. **Fix**: null-guard the read — `__current_this != null ? it :
   undefined`. Additive to #895's gating: it only changes the *value* the
   existing `readsCurrentThis` branch yields when the global is null; it never
   widens which bodies read the global. Array.prototype.{every,…} callbacks and
   top-level strict `this` (#873/#895-fixed) are unaffected (they bind `this`
   via a local or never set `readsCurrentThis`).

2. **`src/codegen/statements/nested-declarations.ts`** — the capture loop for a
   nested `FunctionDeclaration` iterated `referencedNames` (which includes
   `"this"`) and captured the outer `this` when the enclosing fctx had a `this`
   local (always true inside a method/ctor). **Fix**: skip `this`/`super` —
   a `FunctionDeclaration` is not a lexical-`this` form. `ThisKeyword` then
   falls through to the `undefined` / `__current_this` resolution, correct for
   a free function. (Arrow functions are compiled in `closures.ts`, which keeps
   lexical `this` capture — this branch only handles `FunctionDeclaration`s.)

## Why it can't regress the #895-fixed cases
- Top-level strict `this` and `"use strict"` directive-prologue functions bind
  `this` differently / don't take the `readsCurrentThis` branch — unchanged.
- Array.prototype callbacks dispatched by the host install a **non-null**
  receiver into `__current_this`; the null-guard passes it straight through.
- The only behavior change for the `readsCurrentThis` branch is: a **null**
  global now yields `undefined` instead of JS `null`. That is the spec-correct
  result for a strict free function with no receiver, and matches the
  pre-#1636-S1 fallback. One #1636-S1 unit test that asserted the buggy `null`
  was updated to assert `undefined`.

## Repro (confirmed before fix → after fix)
Using the exact test262 wrap (`buildImports` harness):
- `10.4.3-1-30-s` shape: `-1` (FAIL) → `1` (PASS)
- class-method nested-fn `typeof this`: `"object"` → `"undefined"`
- strict fn-expr `this === undefined`: `false` → `true`
- elision-iter method callCount: stays `1` (the over-count symptom resolved)

## Files
- `src/codegen/expressions.ts` — ThisKeyword null-guard on the
  `readsCurrentThis` / `__current_this` read.
- `src/codegen/statements/nested-declarations.ts` — skip `this`/`super` capture
  for nested function declarations.
- `tests/issue-1702-strict-this.test.ts` — 7 regression tests (both shapes).
- `tests/issue-1636-s1-tojson-this.test.ts` — updated the one unit test that
  asserted the old buggy `null` to assert the spec-correct `undefined`.

## Notes / out of scope
- A SEPARATE pre-existing bug exists for **module-global** function
  expressions / arrows (`const f = function(){…}` at module top level, called
  by name): the direct-call site reloads the callee via a stale/off-by-one
  global index (`global.get` of a string-constant global) → `illegal cast` at
  runtime. This pre-dates #1340/#1636-S1 (reproduced at `e5f1dc720`) and is
  NOT a strict-`this` issue. It is what makes the `tests/function-expressions`
  and `tests/equivalence/arrow-call-apply` module-level cases fail on clean
  main too. Tracked separately — not in scope for #1702.

Expected impact: ~+66 test262 (recover toward ~70.40%).
