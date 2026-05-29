---
id: 1721
title: "ES3 (RESIDUAL of #1455): 'class extends Function' / 'class extends Object' instanceof returns false"
status: ready
created: 2026-05-29
updated: 2026-05-29
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

## Root-cause hypothesis

`src/codegen/builtin-tags.ts` `BUILTIN_TYPE_TAGS` /
`BUILTIN_PARENTS_HOST_CONSTRUCTIBLE` do not list `Function` and `Object`. A class
that `extends Function`/`Object` therefore is not externref-backed / not tagged,
so the runtime `__instanceof` tag-chain walk added in #1455 never matches.
`Object` (ordinary object parent) and `Function` (callable parent) are special
cases: `extends Object` should produce an ordinary subclass whose prototype chain
reaches `Object.prototype`; `extends Function` produces a callable subclass whose
chain reaches `Function.prototype`.

Spec: [§10.2.1 / §15.7.14 ClassDefinitionEvaluation](https://tc39.es/ecma262/#sec-runtime-semantics-classdefinitionevaluation),
[§7.3.20 OrdinaryHasInstance](https://tc39.es/ecma262/#sec-ordinaryhasinstance).

## Example failing tests

- `test/language/expressions/class/subclass-builtins/subclass-Function.js`
- `test/language/expressions/class/subclass-builtins/subclass-Object.js`
- `test/language/statements/class/subclass-builtins/subclass-Function.js`
- `test/language/statements/class/subclass-builtins/subclass-Object.js`

## Acceptance criteria

- All four `subclass-Function` / `subclass-Object` tests pass (`instanceof Sub`
  and `instanceof Function`/`Object` both true).
- No regression in #1455's subclass-builtins tests (Map/TypedArray/WeakMap/etc.).

## Source

Filed by product-owner test262 triage (ES3 / edition-0 view) 2026-05-29 against
main baseline (`.test262-cache/test262-current.jsonl`, 48,117 records).
