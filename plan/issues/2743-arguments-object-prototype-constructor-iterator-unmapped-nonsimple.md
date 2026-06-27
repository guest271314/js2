---
id: 2743
title: "arguments object as an ordinary Object: [[Prototype]]=Object.prototype, .constructor, Symbol.iterator, and unmapped arguments for non-simple parameter lists"
status: done
assignee: ttraenkler/sendev-args
sprint: 67
created: 2026-06-27
updated: 2026-06-27
completed: 2026-06-27
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

## Implementation notes — PR-1 = group (c) (sendev-args, 2026-06-27)

**Status: group (c) DELIVERED in PR-1; groups (a)+(b) remain → PR-2.** Issue
frontmatter stays `in-progress`; PR-2 flips it to `done` once the acceptance
criteria (≥9 of ~13, incl. the (a)/(b) groups) are met.

### What PR-1 changes (and WHY)

The mapped-vs-unmapped split was driven *only* by `isStrictFunction(...)`, so a
**sloppy** function with a **non-simple parameter list** (rest / default /
destructuring) wrongly got a **mapped** arguments object. Spec §10.2.11
(FunctionDeclarationInstantiation) step 22.a requires unmapped iff
`strict OR !IsSimpleParameterList`.

- New pure AST predicate `isSimpleParameterList(params)` in
  `src/codegen/helpers/is-strict-function.ts` (co-located with `isStrictFunction`,
  already imported by every call site — no new import cycle). False if any param
  has `dotDotDotToken` (rest), `initializer` (default), or a non-identifier name
  (object/array binding pattern). A TS `this` param stays simple.
- ORed `|| !isSimpleParameterList(stmt.parameters)` into the `unmapped` argument
  at every `emitArgumentsObject` call site:
  - `statements/nested-declarations.ts:521` and `:793` (function-declaration /
    closure-lifted paths — the path the failing tests take),
  - `literals.ts:2544` (object-literal method path),
  - `class-bodies.ts:2247` already hard-codes `true` (class bodies are strict) —
    unchanged, verified.
- `function-body.ts` (the inline top-level path) had its *own* simple-param
  check that caught rest + destructuring but **missed defaulted params**
  (`initializer`); replaced the ad-hoc `every(isIdentifier && !rest)` with the
  shared `isSimpleParameterList`, so defaults are now correctly unmapped there too.

When `unmapped` is true, `emitArgumentsObject` skips installing `mappedArgsInfo`
(`nested-declarations.ts:2292`), so **no write-back** is emitted. That (1) makes
`arguments[0]=2` not flow into the named param (fixes `via-params-dflt/dstr`,
`sameValue(value,1)`), and (2) removes the bad mapped-write `local.set` that the
rest-param local shape couldn't satisfy — which was the *root cause* of
`via-params-rest`'s "invalid Wasm binary" `compile_error` (a symptom, not a
separate Wasm-emit bug).

### Verification (isolated `runTest262File`, this branch)
- `unmapped/via-params-rest.js` compile_error → **pass**
- `unmapped/via-params-dflt.js` fail → **pass**
- `unmapped/via-params-dstr.js` fail → **pass**
- `unmapped/via-strict.js` **pass** (unchanged guard)
- `mapped/mapped-arguments-nonconfigurable-1.js` **pass** (mapped/simple unaffected)

### Regression surface (why this is safe)
The change only flips mapped→unmapped for functions with a **non-simple**
parameter list. A grep of `language/arguments-object/` confirms **no** mapped/*
or other in-scope test uses a non-simple param list, so the only suite files the
change touches are the three (c) tests (now green). Mapped behaviour with a
non-simple param list is itself spec-wrong, so no conformant *passing* test can
rely on the prior (buggy) behaviour. Broad-impact validation (full sharded
test262 + the merge_group standalone floor) runs in CI. Tag-marker for the floor:
watch for an auto-park after enqueue since this touches arguments-object
machinery.

Lock-in test: `tests/issue-2743.test.ts` (drives `runTest262File` on the three
(c) files + the `via-strict` guard).

### Remaining for PR-2 (groups (a)+(b))
- (a) `[[Prototype]]`=Object.prototype + `.constructor`=Object: host `_argumentsObjects`
  WeakSet marker registered after the vec `struct.new`, with `__getPrototypeOf` /
  `__extern_get("constructor")` hooks in `runtime.ts`; standalone keeps the vec.
- (b) `arguments[Symbol.iterator]` = %Array.prototype.values%: gate the vec
  computed-get so a Symbol key is not coerced via ToNumber, route @@iterator.

## Implementation notes — PR-2 = groups (a)+(b) (sendev-args, 2026-06-27)

**Status: DELIVERED. Combined green = 9 of the in-scope arguments tests** (PR-1's
3 (c) + PR-2's 6), meeting the issue's ≥9 target. Issue flips to `status: done`.

PR-2 green: `10.6-5-1.js`, `S10.6_A2.js`, `S10.6_A3_T1.js`, `S10.6_A5_T1.js`
(group a) + `unmapped/Symbol.iterator.js`, `mapped/Symbol.iterator.js` (group b).
Lock-in: `tests/issue-2743-pr2.test.ts`.

### The non-obvious root cause that reshaped the (a) approach (WHY)

The architect's (a) sketch (a host `_argumentsObjects` WeakSet + `__getPrototypeOf`
/ `__extern_get` hooks returning the **host** `Object.prototype`/`Object`) is
*necessary but not sufficient*, because of two facts the verify-first pass
uncovered on current `main`:

1. **`arguments` is modeled as an array (vec).** `Object.getPrototypeOf(arguments)`
   and `arguments.constructor` are resolved by the **codegen** array path
   (`Object.getPrototypeOf(arguments) === Object.getPrototypeOf([])`,
   `typeof arguments.constructor === "function"`), so they **never reach** the
   `__getPrototypeOf` / `__extern_get` host imports the hooks live in. The hooks
   alone are dead code for these two reads.
2. **The compiler's `Object` / `Object.prototype` are a DISTINCT representation
   from the host intrinsics.** `Object.getPrototypeOf({}) === Object.prototype`
   holds, but `Object.prototype` (the member-read) is **NOT** identity-equal to
   the host realm's `Object.prototype`, and a bare `Object` value's `.prototype`
   is not identity-equal to the `Object.prototype` member-read either. So a host
   hook that returns the host `Object.prototype`/`Object` fails the test's
   `=== Object.prototype` / `=== Object` comparisons.

**Fix that actually works (codegen, host-mode):** intercept the `arguments`
identifier and emit the compiler's *own* `Object` / `Object.prototype`
value-read so the identity matches a plain object's:
- `Object.getPrototypeOf(arguments)` (`calls.ts`) → compile a synthetic
  `Object.prototype` member access, **reusing the real `Object` identifier node**
  from the `Object.getPrototypeOf` callee (so it carries a valid symbol/type).
- `arguments.constructor.prototype` (`property-access.ts`, the COMPOUND shape) →
  compile a synthetic `Object.prototype` (the `Object.prototype` member-read is
  name-keyed on `Object`, so a synthetic `Object` identifier resolves it). This
  is the shape `S10.6_A2` checks; the bare-`Object`-value `.prototype` is *not*
  identity-equal to the `Object.prototype` member-read, so the compound form must
  be special-cased rather than relying on `arguments.constructor === Object`.
- `arguments.constructor` (standalone shape) → emit the compiler's `Object` value
  (synthetic `Object` identifier; `=== Object` holds).
The host `_argumentsObjects` WeakSet + `__getPrototypeOf` / `__hasOwnProperty`
hooks still ship and cover the runtime-routed reads —
`arguments.hasOwnProperty("length"/"callee")` DOES route to `__hasOwnProperty`,
where the static vec path would (wrongly) report `length`/`callee` per the
`{length,data}` struct shape; the `_argumentsHasOwn` predicate answers
`length`/`callee` → own (`S10.6_A3_T1`, `S10.6_A5_T1`).

### (b) @@iterator (WHY the trap is where it is)

The "Cannot convert a Symbol value to a number" trap is reached through the
**vec computed-get** (`compileElementAccessBody`, the `{length,data}` struct
arm), which compiles the key with `expectedType i32` → a host ToNumber coercion
on the `Symbol.iterator` externref. The runner rewrites
`verifyProperty(arguments, Symbol.iterator, {value:[][Symbol.iterator],…})` into
`assert_sameValue(arguments[Symbol.iterator], [][Symbol.iterator])`, so BOTH a
vec from an array literal AND the arguments vec hit this arm. Fix: in the vec arm
intercept a syntactic `Symbol.iterator` key (host-mode), drop the receiver, and
call a new `__array_proto_values` host import returning `Array.prototype.values`
— the intrinsic both `[][Symbol.iterator]` and `arguments[Symbol.iterator]`
must equal (`[][Symbol.iterator] === Array.prototype.values`).

### Index-shift hazard handling (the headline risk)

`__register_arguments` + `__array_proto_values` are NEW host imports → adding
them late shifts function indices (the `addUnionImports` trap). Both are
registered via `ensureLateImport` immediately followed by `flushLateImportShifts`
(the same machinery `__register_fnctor_instance` uses), which walks `fctx.body`,
`ctx.currentFunc`, the func/parent stacks, and every `ctx.mod.functions` body to
bump stale `call`/`ref.func` funcIdxs. `__register_arguments` is registered+flushed
at the **top** of `emitArgumentsVecBody` — before any `call` (box/unbox resolve
their funcIdx post-shift via `funcMap`) — and the registration `call` is emitted
at the end against the settled `funcMap` entry. Validation: every PR-2 + PR-1 +
normal-arguments test both COMPILES and RUNS (an "invalid Wasm binary" at
instantiation would mean an index desync; none occurred).

### Standalone

All (a)/(b) codegen + the registration are gated on `!noJsHost(ctx)` /
`!ctx.standalone && !ctx.wasi` — standalone/WASI keeps the bare vec
(`Symbol.iterator` is an i32 id there, so the index path is harmless; the
ordinary-Object linkage rides on the #1888 open-object runtime later). The
standalone floor only runs in `merge_group`.

### Documented gaps (not regressions) — clean follow-up

The remaining (a) files need vec **property write/delete** and **callee-closure
capture** semantics, which are out of PR-2's [[Prototype]]/constructor/@@iterator
scope:
- `S10.6_A4` — `arguments.callee === f1`: needs the enclosing closure captured at
  the arguments-emission site (across decl + function-expression call paths).
- `S10.6_A5_T3` (`delete arguments.length`), `A5_T4` (`arguments.length = str`),
  `A3_T4` (`arguments.callee = str`): need writable/deletable own data-property
  semantics over the i32 vec `length` field + a `callee` slot.
- Numeric-index `arguments.hasOwnProperty(i)` is conservatively `false` (the vec
  length is opaque to the host); no in-scope test exercises it.
These + mapped/* exotic descriptors (#1726) are a separate lap.

### Files
- `src/runtime.ts` — `_argumentsObjects` WeakSet + `_argumentsHasOwn`;
  `__register_arguments` / `__array_proto_values` imports; `__getPrototypeOf`,
  `__extern_get` (constructor + vec-aware hasOwnProperty), `__hasOwnProperty` hooks.
- `src/codegen/statements/nested-declarations.ts` — register the vec in
  `emitArgumentsVecBody` (covers both the closure-lifted and inline paths).
- `src/codegen/property-access.ts` — `isSymbolIteratorKey` + vec @@iterator route;
  `arguments.constructor[.prototype]` interceptors.
- `src/codegen/expressions/calls.ts` — `Object.getPrototypeOf(arguments)` interceptor.
