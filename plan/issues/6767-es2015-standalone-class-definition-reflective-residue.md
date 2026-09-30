---
id: 6767
title: "ES2015 standalone class definition — reflective residue: static-member descriptors, `getPrototypeOf(C.prototype)`, heritage `prototype` validation, restricted-id static accessors"
status: ready
sprint: current
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6651, 5318, 5195, 4770, 5350, 5269]
loc-budget-allow:
  # 2026-09-30 (#6767 plan): static-member descriptor synthesis at the gOPD
  # literal-key fold, the base-class prototype link, two heritage proofs,
  # and the restricted-id static accessor dispatch. Wiring only in the
  # listed files; any helper longer than ~40 lines goes in the NEW leaf
  # `src/codegen/class-static-descriptor.ts`.
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/class-static-descriptor.ts
  - src/codegen/class-proto-object.ts
  - src/codegen/class-heritage-check.ts
  - src/codegen/class-static-metadata.ts
  - src/codegen/object-runtime-prototype.ts
  - scripts/compiler-boundaries.json
  # 2026-09-30 (#6767 implementation): ONE import line. The call-site
  # parameter inference must withdraw its `$C` narrowing for a
  # `<Class>.prototype` argument (the standalone prototype is an `$Object`,
  # never a `$C`) — the predicate lives in class-proto-object.ts; the
  # consuming condition is edited in place (line-neutral).
  - src/codegen/declarations/param-return-inference.ts
---

## Problem

`language/statements/class/definition/**` still has 18 non-pass rows on
standalone (2026-09-29 22:47 UTC baseline). #5318 (class r4/r5, claimed
2026-09-04, no activity since 2026-09-06) listed them and gave the cluster
up as "the reflective own-property surface on the class object … needs the
reflective natives redirected" (#5195 cluster B) plus "every row that would
require ADDING a throw". This issue takes the definition cluster over from
#5318 — its claim is stale (26 days) and its worktree is gone; #5318 keeps
the computed-property-name work it actually did.

Measured on `origin/main` @ `eb57f327`, standalone:

| probe | program | main | node |
| --- | --- | --- | --- |
| p11 | `class C { method(){} static staticMethod(){} get x(){} static get sx(){} }` — `gOPD(C,'staticMethod') === undefined` (1) / is a function descriptor (2); `gOPD(C,'sx') === undefined` (4); `getPrototypeOf(C.prototype) === Object.prototype` (8); `getPrototypeOf(C) === Function.prototype` (16); `getOwnPropertyNames(C)` has `staticMethod` (32) and `prototype` (64); `C.hasOwnProperty('staticMethod')` (128) | **229** (=1+4+32+64+128) | 250 (=2+8+16+32+64+128) |
| p12 | `class Class { method(){} get accessor(){} set accessor(x){} 1(){return 7} get eval(){return 1} static get eval(){return 3} }` — no `caller`/`arguments` own props on `instance.method` (1); `gOPD(Class.prototype,'accessor').get.name === 'get accessor'` (2) / `.set.name` (4); `gOPD(Class.prototype,'1').value() === 7` (8); `Class.eval === 3` (16); `new Class().eval === 1` (32); `gOPD(Class,'eval') !== undefined` (64); `class D extends (function(){}).bind() {}` throws TypeError (128); `class E extends 7 {}` throws TypeError (256) | **303** (=1+2+4+8+32+256) | 511 |

So: `Object.getOwnPropertyDescriptor(C, <static method or accessor>)`
answers `undefined` although `getOwnPropertyNames` and `hasOwnProperty` see
the key; a static accessor named `eval` resolves to the INSTANCE accessor;
a base class's `C.prototype` does not report `Object.prototype` as its
prototype and `C` does not report `Function.prototype`; a heritage that is
a constructor WITHOUT a `prototype` property (a bound function) does not
throw at definition time.

### Rows (standalone non-pass; all under `language/statements/class/definition/`)

Step 1 (descriptors) — `methods.js`, `accessors.js`, `getters-prop-desc.js`,
`setters-prop-desc.js`, `numeric-property-names.js` (all fail with
"Cannot convert undefined or null to object" at the first `gOPD(C, …)`),
`getters-restricted-ids.js`, `setters-restricted-ids.js`.

Step 2 (prototype links) — `basics.js`.

Step 3 (heritage) — `constructable-but-no-prototype.js`,
`prototype-setter.js`, `invalid-extends.js`.

Step 4 (function-object restricted properties) —
`methods-restricted-properties.js` (`instance.method.caller` must throw a
TypeError — %ThrowTypeError%), `fn-name-accessor-get.js`,
`fn-name-accessor-set.js` (trap at `:855-856` — measure).

Recorded only — need a `this`-before-`super()` runtime flag the compiler
does not have (#5350 round-3 g5/n3): `this-access-restriction.js`,
`this-access-restriction-2.js`, `this-check-ordering.js`,
`side-effects-in-extends.js` (IR support-unit CE), `prototype-getter.js`.

Row list: `.tmp/6767/rows.txt` (paths relative to `test262/test/`).

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

### Step 0 — base copies and the before-state

`mkdir -p .tmp/6767 && git archive origin/main src | tar -x -C .tmp/6767/base-src`;
write p11/p12 to `.tmp/6767/p11.js`, `p12.js` with the probe runner from
#6766's Step 0; run `rows.txt` on the unmodified tree
(`flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts .tmp/6767/rows.txt --isolate --standalone > .tmp/6767/rows-base.log`).

### Step 1 — `gOPD(C, <static member>)` synthesises the descriptor at the fold

`src/codegen/expressions/call-builtin-static.ts:3320-3380` is the
`Object.getOwnPropertyDescriptor` literal-key fold for a class receiver. When
`hasClassStaticMethod(ctx, classIdentity, propLiteral)` or
`ctx.staticAccessorSet.has(`${classIdentity}_${propLiteral}`)` holds it
deliberately skips the fast-path `undefined` and "lets the dynamic fallback
handle the method case via the host import" — on standalone that fallback
is the native `__getOwnPropertyDescriptor`, which has no arm for the class
object carrier, so the answer is `undefined`.

Fix at the fold, mirroring the #4770 arm right below it (`classOwnKey &&
!classIntrinsicOverridden` → `__create_descriptor`):

- static METHOD: emit the method VALUE the way `C.staticMethod` as a value
  compiles today (find the emitter: grep `classStaticMethodNames` in
  `src/codegen/expressions/property-access*.ts` / `class-static-*.ts`; the
  `Object.getOwnPropertyNames(C)` path at `call-builtin-static.ts:3686`
  proves the metadata is there), then
  `__create_descriptor(value, FLAG_WRITABLE | FLAG_CONFIGURABLE)` (flags in
  `object-runtime-descriptors.ts`; §15.7.x: writable, non-enumerable,
  configurable).
- static ACCESSOR: `__create_accessor_descriptor(get, set, FLAG_CONFIGURABLE)`
  (or the existing accessor-descriptor native — grep `__create_descriptor`
  siblings in `object-runtime-descriptors.ts:2990-3020`); the getter/setter
  closure values are the halves `class-static-sidecar.ts` already
  materialises (`staticAccessorHalfIsReceiverFree` at `:172` names how a
  half is fetched).
- numeric static keys (`static 1(){}`) go through the same fold when
  `propLiteral` is the canonical numeric string; verify with
  `numeric-property-names.js`.
- The DYNAMIC-key form `gOPD(C, k)` stays as it is (record it) unless the
  static sidecar already carries a runtime-keyed table — then add the arm to
  `__getOwnPropertyDescriptor` via `fillClassProtoLookupArm`'s sibling
  (`class-proto-lookup.ts:221`), which is the #5195 Step 1.7 idiom.
- `getters-restricted-ids.js` / `setters-restricted-ids.js`: `C.eval`
  answers the INSTANCE accessor's value. `class-static-metadata.ts:289
  restrictedPropertyReceiverIsClass` / `:341 classObjectRestrictedProperty`
  special-case `eval`/`arguments` on a class receiver; a declared static
  accessor of that name must win over the restriction — find the read
  site that consults them and let a declared static accessor take
  precedence.

### Step 2 — a base class links `Object.prototype`; `C` links `Function.prototype`

`class-proto-object.ts:243-260` links `D.prototype.[[Prototype]]` only when
the parent is a class with a prototype `$Object`. A BASE class's prototype
`$Object` keeps `$proto = null`, and `__getPrototypeOf`
(`object-runtime-prototype.ts:513-591`) answers `%Object.prototype%` for a
null `$proto` only through `objectProtoSingletonIdx` — p11 shows that answer
is still not `Object.prototype` for `C.prototype`. Measure first
(`.tmp/6767/q1.js`: `Object.getPrototypeOf(C.prototype) === Object.prototype`,
`Object.getPrototypeOf(C.prototype) === null`, `typeof
Object.getPrototypeOf(C.prototype)`) to learn WHICH object comes back —
likely the prototype read goes through `fnctorGetPrototypeArm`
(`object-runtime-prototype.ts:147`) rather than the `$Object` arm. Then
either link the singleton at class-definition time (the #5350 residual
"needs `D.prototype.[[Prototype]] === Object.prototype`,
`class-proto-object.ts:243-260`") or make the arm answer the singleton.
`Object.getPrototypeOf(C) === Function.prototype` is the same question for
the class object itself (the `%Function.prototype%` carrier the `Function`
brand owns — grep `FUNCTION_PROTO_SINGLETON` / `fillFunctionProtoSingleton`).

### Step 3 — heritage `prototype` validation, compile-time proof only

`src/codegen/class-heritage-check.ts` is COMPILE-TIME PROOF ONLY by design
(its header, review F1 of #5195 r3): never add a runtime arm. Extend
`heritagePrototypeIsProvablyInvalid` (`:290`) with the shapes the rows use:

- `(<function expression or declaration>).bind(…)` — BoundFunctionCreate
  (§10.4.1.3) never creates a `prototype` property, so `Get(superclass,
  "prototype")` is `undefined` → TypeError. Provable when the receiver of
  `.bind` is a function literal, or an identifier whose unique, never-written
  declaration is a function (reuse `bindingIsUniqueAndNeverWritten` and the
  alias-chain walk of `heritageIsProvablyNotConstructor`).
  `constructable-but-no-prototype.js` (`var Base = function() {}.bind();`).
- `prototype-setter.js`: same `Base`, then `Object.defineProperty(Base,
  'prototype', { set })` — a setter-only accessor still reads `undefined`,
  so the same proof applies as long as no statement between the declaration
  and the class can install a GETTER; the simplest sound rule: a
  `defineProperty(Base, 'prototype', <literal without a get/value key>)` on
  that binding keeps the proof, anything else declines.
- `invalid-extends.js`: read the test; add its shape only if it is provable
  the same way, otherwise record it.

The thrown message is the existing one at `:362`. Order: the heritage
expression's side effects run before the throw (§15.7.14 step 5.a–f) —
`prototype-setter.js` asserts the Test262Error from the SETTER is NOT what
escapes (a read never invokes a setter).

### Step 4 — function-object restricted properties (measure first)

Run the three rows; name the first failing assertion. For
`methods-restricted-properties.js` the expected failure is
`assert.throws(TypeError, () => instance.method.caller)` — strict function
objects expose `caller`/`arguments` through %ThrowTypeError% (§10.2.4,
AddRestrictedFunctionProperties applies to %Function.prototype%, not to the
method): the read must reach the `Function.prototype` accessor and throw.
Fix only if the throw can be emitted where the fold already knows the
receiver is a class method value; otherwise record with the mechanism.

### Step 5 — pins, controls, gates, record

- Pin suite `tests/issue-6767-class-definition-reflective.test.ts`: p11
  → 250 and p12 → 511 (or the per-bit sub-assertions, one `it` per
  mechanism, each marked "RED on base"), plus two guards (a plain class
  `gOPD(C.prototype,'method')`, and `class D extends B {}` with a class
  parent — must answer the same on both trees).
- Control (0 pass → non-pass, per-path set diff): every currently-passing
  ES2015 standalone row under `language/statements/class/**` and
  `language/expressions/class/**` (~1,000 rows; #5318 ran a 783-row sweep
  as `Control corpus`, reuse its list if it is in
  `plan/agent-context/`), run once at the end on the merged tree under the
  lock.
- Gates: the chain in #6766 Step 5, identical.
- Record: append `### 2026-09-30 — #6767 implementation (Opus)` to THIS
  file (rows before/after, mechanisms of residuals, pins' base verdict,
  control diff, gates), plus a one-paragraph pointer in
  `plan/issues/5318-es2015-standalone-class-r4.md` ("definition cluster
  moved to #6767") and in
  `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`.

## Acceptance criteria

- Step 1 rows (7) and step 2 row pass on standalone, `--isolate`, on the
  branch with `origin/main` merged in; step 3 rows pass or are recorded
  with the exact declined shape; step 4 measured.
- p11 = 250 and p12 ≥ 447 (=511 − 64 if the dynamic-key gOPD form is
  recorded rather than built) on the branch; the pin file is red on base.
- 0 pass → non-pass across the class control; no new runtime arm in
  `class-heritage-check.ts`.
- All gates green; growth grants in this file's frontmatter only.

## Lane protocol

Same as #6766's (worktree under `/home/user/js2/.claude/worktrees/issue-6767`,
branch `issue-6767-class-definition-reflective`; symlink `node_modules` and
`test262`; `flock /tmp/claude-0/t262.lock` around every runner; push early to
`origin`, no PR; commit subject ends ` ✓`, author Thomas Tränkler, committer
Claude, trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
`Claude-Session: https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`,
`Model: Claude Opus 5.5 High`; never `--no-verify`; no `git stash`).
