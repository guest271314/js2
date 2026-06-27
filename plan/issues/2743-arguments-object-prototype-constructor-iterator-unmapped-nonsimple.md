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

## Implementation Plan (architect: esch, 2026-06-27) — senior-dev

**VERIFIED on current `origin/main` HEAD via the real `runTest262File` runner +
`compile()` probes.** Three independent sub-bugs; (c) is the highest-leverage and
also clears the Wasm-emit failure.

### Root cause (verified)

The `arguments` object is built as a **vec struct** — `{ length:i32,
data:array<externref> }` — by `emitArgumentsVecBody` / `emitArgumentsObject`
(`src/codegen/statements/nested-declarations.ts:2109-2311`). It is NOT an ordinary
Object: no `[[Prototype]]` link to `%Object.prototype%`, no `.constructor`, no
`@@iterator`. So:

- **(a)** `Object.getPrototypeOf(arguments)` → host `__getPrototypeOf` sees an opaque
  vec → null, not `%Object.prototype%`; `arguments.constructor` → `__extern_get(vec,
  "constructor")` → undefined. The tests' catch blocks fire ("arguments doesn't
  exist"). Runner: `10.6-5-1.js` fails `sameValue(Object.getPrototypeOf(arguments),
  Object.getPrototypeOf(...))`.
- **(b)** `arguments[Symbol.iterator]` → the computed member-get on a vec coerces the
  key via `ToNumber` to index the array → **"Cannot convert a Symbol value to a
  number"** (verified both mapped + unmapped). Per §10.4.4.6 step 2 / §10.4.4.7
  step 5, `@@iterator` must be `%Array.prototype.values%`.
- **(c)** A **non-simple parameter list** (rest / default / destructuring) MUST
  produce an **unmapped** arguments object (FunctionDeclarationInstantiation step 22.a:
  unmapped iff `strict OR !IsSimpleParameterList`). But `emitArgumentsObject` is
  invoked with `unmapped = isStrictFunction(stmt, …)` **only** (`nested-declarations.ts:521`,
  and the other call sites) — it ignores the non-simple-params case. So a sloppy
  `function dflt(a, b=0){ arguments[0]=2; }` gets a MAPPED arguments object; the
  `arguments[0]=2` write maps back into param `a` → `value` becomes 2 (`via-params-
  dflt.js`/`via-params-dstr.js` fail `sameValue(value,1)`). For `function rest(a,
  ...b){ arguments[0]=2; }` the mapped write-back tries to `local.set` the named
  param through a type mismatch the rest-param shape can't satisfy → the
  **`local.set[0] expected type (ref …)` "invalid Wasm binary"** at instantiation
  (`via-params-rest.js`, `compile_error`). The Wasm error is a SYMPTOM of the wrong
  (mapped) arguments object; fixing the unmapped detection removes it.

### Changes

**(c) — FIRST, fixes 3 tests incl. the Wasm-emit failure. File:
`src/codegen/statements/nested-declarations.ts` (+ all `emitArgumentsObject` callers).**
- Add `isSimpleParameterList(params: readonly ts.ParameterDeclaration[]): boolean`
  — false if ANY param has `dotDotDotToken` (rest), `initializer` (default), or a
  binding-pattern name (`ts.isObjectBindingPattern`/`ts.isArrayBindingPattern`).
  (The AST predicates already exist piecewise at `src/codegen/declarations.ts:2524-2538`.)
- At every `emitArgumentsObject` call site, change `unmapped` from
  `isStrictFunction(stmt, …)` to `isStrictFunction(stmt, …) || !isSimpleParameterList(stmt.parameters)`.
  Call sites: `nested-declarations.ts:521`, `:793`; `src/codegen/literals.ts:2544`
  (function-expression path); `src/codegen/class-bodies.ts:2247` (already passes
  `true` — methods; verify); and the inline arguments path in
  `src/codegen/function-body.ts:977`. When `unmapped` is true, `mappedArgsInfo`
  (`nested-declarations.ts:2292-2301`) is skipped → no write-back → no bad
  `local.set` → `via-params-rest` compiles AND the indices reflect the call args.
- This is the **highest-confidence, broadest** fix. Land it as PR-1.

**(a) — `[[Prototype]]` + `.constructor`. Files: `src/codegen/...` (mark the vec) +
`src/runtime.ts` (host MOP).** Mark the arguments vec so the host MOP recognizes it:
- Tag it via a runtime registration (a `_argumentsObjects = new WeakSet<object>()`
  populated by a small `__register_arguments(vec)` host import emitted right after
  the `struct.new` in `emitArgumentsVecBody:2254`), mirroring the existing
  `__register_fnctor_instance` pattern (host-mode only; standalone keeps the vec).
- In `__getPrototypeOf` (`runtime.ts:9353`): if `_argumentsObjects.has(obj)` → return
  the real JS `Object.prototype` (the host realm's, the same identity `Object.*`
  resolves to), so `Object.getPrototypeOf(arguments) === Object.prototype` and the
  `.constructor` walk reaches `Object`.
- In the dynamic property read (`__extern_get`, `runtime.ts:~4170`): if
  `_argumentsObjects.has(obj)` and key === `"constructor"` → return host `Object`;
  fall through to the proto walk for other string keys. Numeric indices + `length`
  keep the existing vec path.

**(b) — `@@iterator`. Files: the computed member-get codegen + `__extern_get`.**
- The Symbol→number coercion happens because the computed-index lowering applies
  `ToNumber` to ANY key on a vec. Gate it: a **Symbol** key must NOT be coerced to a
  number — route a Symbol-keyed get on a vec/arguments to the property path. In
  `__extern_get` (or the symbol-keyed member-access path), when
  `_argumentsObjects.has(obj)` (or generally a vec) and `typeof key === "symbol" &&
  key === Symbol.iterator` → return `%Array.prototype.values%` bound to the vec's
  indexed values (the host `Array.prototype.values` invoked on an array view of the
  vec, or a small closure yielding `obj[0..length-1]`). This fixes both
  `unmapped/Symbol.iterator.js` and `mapped/Symbol.iterator.js` (no Symbol→number
  trap). NB: locate the Symbol→number trap site for indexed get — the compile-time
  emit is in `binary-ops.ts:277`/`string-ops.ts:2074`; the *runtime* "in test()"
  message means the trap is reached via the dynamic key path, so the guard belongs at
  the vec computed-get dispatch BEFORE ToNumber.

### Edge cases
- Mapped vs unmapped `@@iterator`: BOTH get `%Array.prototype.values%` (the iterator
  is identical for both forms; only index↔param aliasing differs, which (c) governs).
- `arguments.length` / numeric `arguments[n]` must keep working (existing vec path) —
  the (a)/(b) MOP hooks must fall through to the vec path for those keys.
- Strict functions already get unmapped via `isStrictFunction`; the new
  `|| !isSimpleParameterList` is additive (don't double-apply).
- Standalone/WASI: the `__register_arguments` + host-`Object.prototype` linkage is
  host-mode; standalone keeps the vec. (a)/(b) acceptance is host-mode (the tests run
  host). Note a standalone follow-up if needed.
- OUT (per issue): `mapped/*` exotic descriptor aliasing → #1726; eval `10.5-*-s.js`.

### Verdict
**Senior-dev** (the issue's routing — (a)/(b) touch the host MOP + a new vec marker;
(c) touches arguments-object lowering across 5 call sites). Sequence: **PR-1 = (c)**
(simple-param-list → unmapped; clears the Wasm-emit failure + 3 tests, lowest risk),
**PR-2 = (a)+(b)** (vec marker + `__getPrototypeOf`/`__extern_get`/`@@iterator` MOP
hooks). (c) alone already meets a meaningful slice of the ≥9 target; (a)+(b) banks the
remaining (a)-group (≥5) and the 2 Symbol.iterator tests.

### Test files (authoritative runner reasons, current main)
- `S10.6_A2.js`/`S10.6_A4.js`/`S10.6_A3_T1.js` → "arguments doesn't exist" (a)
- `10.6-5-1.js` → `getPrototypeOf(arguments)` ≠ `Object.prototype` (a)
- `unmapped/Symbol.iterator.js`, `mapped/Symbol.iterator.js` → Symbol→number trap (b)
- `unmapped/via-params-dflt.js`, `via-params-dstr.js` → `sameValue(value,1)` (c)
- `unmapped/via-params-rest.js` → `local.set[0] expected type` invalid Wasm (c)
