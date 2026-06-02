---
id: 1721
title: "ES3 (RESIDUAL of #1455): 'class extends Function' / 'class extends Object' instanceof returns false"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: subclass-builtins-instanceof
goal: test262-conformance
sprint: 57
es_edition: 0
test262_fail: 4
test262_category: language/expressions/class/subclass-builtins, language/statements/class/subclass-builtins
related: [1455, 1366]
---
# #1721 — ES3: subclassing Function / Object — instanceof on the subclass fails

## Problem (edition ≤ ES3, residual of #1455)

Four tests fail:

```js
const Subclass = class extends Function {};
const sub = new Subclass();
assert(sub instanceof Subclass);   // ours: fails (returned 2)
assert(sub instanceof Function);
```

and the same with `extends Object`. #1455 (`done`) implemented instanceof for
subclassing the *exotic* builtins it enumerated (Map, WeakMap, all concrete
TypedArrays, DataView, WeakRef) via the `__tag_user_class` tag chain — but
**`Function` and `Object` were not added** to the builtin-parent registry, so
`new Subclass() instanceof Subclass` is false.

These are edition-0 sputnik-style tests (no es5id/esid/feature tag), classified
≤ ES3 by `scripts/generate-editions.ts`.

## Root cause (confirmed)

Three coupled gaps, all anchored on `Object` / `Function` being absent from the
#1455 registration:

1. `src/codegen/builtin-tags.ts` — `Object` / `Function` were in
   `BUILTIN_TYPE_TAGS` but **not** in `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`, so a
   class that `extends Function`/`Object` was not externref-backed / not tagged,
   and the runtime `__instanceof` tag-chain walk added in #1455 never matched.
2. `src/runtime.ts` — the `extern_class new` resolver's `builtinCtors` map had
   `Number`/`Boolean`/`String` but not `Object` / `Function`, so `super()`
   lowering to `__new_Object()` / `__new_Function()` threw "No dependency
   provided for extern class".
3. `src/codegen/expressions/identifiers.ts` `tryStaticInstanceOf` walks the
   parent through `isBuiltinSubtype(builtinParent, ctorName)`. With no
   `Function -> Object` edge in `BUILTIN_PARENT`, a subclass of Function
   statically reported `instanceof Object === false`.

Spec: [§10.2.1 / §15.7.14 ClassDefinitionEvaluation](https://tc39.es/ecma262/#sec-runtime-semantics-classdefinitionevaluation),
[§7.3.20 OrdinaryHasInstance](https://tc39.es/ecma262/#sec-ordinaryhasinstance).

## Fix

- Added `Object`, `Function` to `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`
  (`builtin-tags.ts`).
- Added `Object`, `Function` to the runtime `builtinCtors` map (`runtime.ts`).
- Added the `Function -> Object` edge to `BUILTIN_PARENT` (`builtin-tags.ts`) —
  the one provably-true (never false-negative) `instanceof Object` chain edge;
  the other builtins' Object edges are deliberately left to runtime.

## Example failing tests

- `test/language/expressions/class/subclass-builtins/subclass-Function.js`
- `test/language/expressions/class/subclass-builtins/subclass-Object.js`
- `test/language/statements/class/subclass-builtins/subclass-Function.js`
- `test/language/statements/class/subclass-builtins/subclass-Object.js`

## Acceptance criteria

- All four `subclass-Function` / `subclass-Object` tests pass (`instanceof Sub`
  and `instanceof Function`/`Object` both true). ✅
- No regression in #1455's subclass-builtins tests (Map/TypedArray/WeakMap/etc.). ✅

## Test Results

- `tests/issue-1721.test.ts` — 4/4 pass (Object, Function, class-expression
  Object, subclass-of-Object instance method).
- `tests/issue-1455.test.ts` — 9/9 pass (no regression).

## Source

Filed by product-owner test262 triage (ES3 / edition-0 view) 2026-05-29 against
main baseline (`.test262-cache/test262-current.jsonl`, 48,117 records).
