---
id: 2743
title: "arguments object as an ordinary Object: [[Prototype]]=Object.prototype, .constructor, Symbol.iterator, and unmapped arguments for non-simple parameter lists"
status: ready
sprint: 67
created: 2026-06-27
updated: 2026-06-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: ES3
language_feature: arguments-object
goal: test262-conformance
related: [1726, 2704]
depends_on: []
---
# #2743 — arguments object: ordinary-Object semantics + unmapped for non-simple params

`#2704` fixed the trailing-comma `arguments.length` plumbing and the missing
sloppy binding. The residual `language/arguments-object` fails are about the
arguments object being a **real object with `Object.prototype` on its prototype
chain** and about producing an **unmapped** arguments object when the function
has a non-simple parameter list. These are distinct from #2704 (length) and
#1726 (mapped exotic descriptors).

## Failing test262 files (current main)

**(a) `[[Prototype]]` of the arguments object is `Object.prototype`; its
`.constructor` chain resolves to `Object`** — currently the arguments object is
not linked to `Object.prototype` (tests report "arguments doesn't exist" from
their catch blocks):
- `test/language/arguments-object/S10.6_A2.js`
  (`arguments.constructor.prototype === Object.prototype`)
- `test/language/arguments-object/10.6-5-1.js`
  (`Object.getPrototypeOf(arguments) === Object.prototype`)
- `test/language/arguments-object/S10.6_A4.js`
- `test/language/arguments-object/S10.6_A5_T1.js`,
  `…/S10.6_A5_T3.js`, `…/S10.6_A5_T4.js`
- `test/language/arguments-object/S10.6_A3_T1.js`, `…/S10.6_A3_T4.js`

**(b) `arguments[Symbol.iterator]` is `%Array.prototype.values%`** — iterating
`arguments` currently traps with "Cannot convert a Symbol value to a number"
(the Symbol key is being coerced to a numeric index):
- `test/language/arguments-object/unmapped/Symbol.iterator.js`
- `test/language/arguments-object/mapped/Symbol.iterator.js`

**(c) Non-simple parameter lists (destructuring / defaults / rest) must produce
an *unmapped* arguments object (§10.4.4.7 step calling `CreateUnmappedArguments`)
and the binding must still be readable:**
- `test/language/arguments-object/unmapped/via-params-dstr.js`
- `test/language/arguments-object/unmapped/via-params-dflt.js`
- `test/language/arguments-object/unmapped/via-params-rest.js`
  (currently `compile_error: invalid Wasm binary` — hard sub-case)

## Acceptance criteria

- Group (a): `Object.getPrototypeOf(arguments) === Object.prototype` and
  `arguments.constructor === Object`; ≥5 of the listed (a) files pass.
- Group (b): `arguments[Symbol.iterator]` is callable and iterates the indexed
  values; both Symbol.iterator files pass (no Symbol→number coercion trap).
- Group (c): a function with a destructuring/default parameter produces an
  unmapped arguments object whose indices reflect the *call* arguments; ≥2 of 3
  pass (`via-params-rest` may remain if the Wasm-emit fix is larger — note it).
- **Target: ≥9 of the ~13 in-scope arguments tests fixed.** No regression in the
  arguments tests already green from #2704.

## Scope / out of scope
- OUT: `mapped/*` exotic descriptor tests (mapped index↔param aliasing, callee
  poison) → tracked by #1726; async-generator-method trailing-comma+spread
  `arguments.length` (`cls-*-async-gen-meth-*-trailing-comma-spread-operator.js`,
  `async-gen-meth-args-trailing-comma-spread-operator.js`) → #2704 follow-up;
  eval-based `10.5-*-s.js` SyntaxError tests (eval-blocked).
- Spec: ES2023 §10.4.4 (Arguments Exotic Objects), `CreateUnmappedArgumentsObject`
  §10.4.4.6, `CreateMappedArgumentsObject` §10.4.4.7.
