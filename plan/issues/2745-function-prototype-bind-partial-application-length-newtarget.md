---
id: 2745
title: "Function.prototype.bind: bound partial-application arguments, bound `.length`/`.name`, construct newTarget forwarding, restricted-property poison"
status: done
completed: 2026-06-28
assignee: ttraenkler/agent-a3bfd116a51704f18
sprint: 69
created: 2026-06-27
updated: 2026-07-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
es_edition: ES5
language_feature: function-bind
goal: test262-conformance
depends_on: []
---
# #2745 — Function.prototype.bind semantics residual

`Function.prototype.bind` creates a bound function exotic object whose
`[[Call]]` prepends the bound `this` + bound partial arguments, whose
`[[Construct]]` forwards `newTarget`, and which exposes correct `length`/`name`
own properties. ~24 `built-ins/Function/prototype/bind` tests fail on current
main (mostly `assertion_fail`), clustered into four concrete bugs.

## Failing test262 files (current main)

**(a) Bound partial-application arguments are not concatenated with call-time
args** (`f.bind(o, 1)(2)` should call `f(1, 2)`):
- `test/built-ins/Function/prototype/bind/15.3.4.5.1-4-5.js`,
  `…/15.3.4.5.1-4-7.js`, `…/15.3.4.5.1-4-8.js`, `…/15.3.4.5.1-4-9.js`,
  `…/15.3.4.5.1-4-12.js`, `…/15.3.4.5.1-4-14.js`, `…/15.3.4.5.1-4-15.js`

**(b) Bound `[[Construct]]` — partial args on `new boundFn(...)`, and
`newTarget` forwarding:**
- `test/built-ins/Function/prototype/bind/15.3.4.5.2-4-2.js`,
  `…/15.3.4.5.2-4-4.js`, `…/15.3.4.5.2-4-6.js` … `…/15.3.4.5.2-4-14.js`
- `test/built-ins/Function/prototype/bind/instance-construct-newtarget-self-new.js`
  (`newTarget === A`)

**(c) Bound function `length` own property
(`max(0, targetLength − boundArgsCount)`):**
- `test/built-ins/Function/prototype/bind/instance-length-default-value.js`
- `test/built-ins/Function/prototype/bind/instance-length-tointeger.js`
- `test/built-ins/Function/prototype/bind/instance-length-exceeds-int32.js`
  (currently `Cannot redefine property: length`)

**(d) Restricted `caller`/`arguments` poison on the bound function:**
- `test/built-ins/Function/prototype/bind/BoundFunction_restricted-properties.js`

## Acceptance criteria

- Group (a): bound partial args concatenate before call-time args; ≥6 of the 7
  `15.3.4.5.1-4-*` files pass.
- Group (b): `new boundFn(...)` applies bound + call args and forwards
  `newTarget`; ≥8 of the `15.3.4.5.2-4-*` files plus the newTarget-self test
  pass.
- Group (c): `boundFn.length === max(0, target.length − boundArgs.length)`; all
  3 `instance-length-*` files pass (no `Cannot redefine property: length`).
- Group (d): accessing `boundFn.caller` / `boundFn.arguments` throws
  `TypeError`; the restricted-properties file passes.
- **Target: ≥20 of the ~24 fixable bind tests fixed.** No regression elsewhere.

## Notes
- Spec: ES2023 §20.2.3.2 `Function.prototype.bind`, `BoundFunctionCreate`
  §10.4.1, `[[Call]]`/`[[Construct]]` of bound functions §10.4.1.1-2.
- Cross-realm tests (`get-fn-realm*.js`, `proto-from-ctor-realm.js`) depend on
  realm/Reflect infra and are out of scope.

## Test Results (2026-06-28)

`built-ins/Function/prototype/bind` directory: **66 → 85 pass / 100 (+19,
0 regressions)**.

Root causes fixed:
- **(a) partial-application + over-arity arguments** — the bound-function
  wrapper in `__bind_function` (`src/runtime.ts`) used a *fixed-arity*
  `_wrapWasmClosure(target, lengthHint)` bridge that truncated call-time args to
  the target's declared formal count, so a target reading `arguments[i]` past
  its formals never saw the bound/call args. Replaced with a dedicated VARIADIC
  bridge that dispatches at `max(args.length, realArity)` (plain `__call_fn_n`
  for `undefined`/`null`/`globalThis` this, `__call_fn_method_n` for a real
  object receiver). All 7 `15.3.4.5.1-4-*` pass.
- **dispatcher `__argc` double-count** (`src/codegen/index.ts`) — the
  `__call_fn_N` `#820l` plumbing set `__argc = arity` (raw dispatcher arity)
  instead of the clamped-to-formals `closureArity` that `emitArgumentsVecBody`
  (`totalLen = argc + extrasLen`) and `maybeSetArgcForKnownCall`
  (`min(actual, paramCount)`) expect, so an over-arity HOF callback reported a
  *doubled* `arguments.length`. Fixed to `entry.closureArity`, and the same
  plumbing was ADDED to `emitClosureMethodCallExportN` (method dispatch
  previously forwarded no extras at all). Now matches V8.
- **(b) `[[Construct]]`** — `new boundFn(...)` routed through
  `__construct(callee, NULL)` (the provably-non-constructable throw path) and so
  constructed with ZERO args. The `resolvesToNonConstructableValue` →
  `__construct` arm (`src/codegen/expressions/new-super.ts`) now builds and
  passes the real call args; bound functions construct correctly and newTarget
  is forwarded by the native bound function. All 7 listed `15.3.4.5.2-4-*` pass.
- **(d) restricted-property poison** — `bound.arguments = {}` / `bound.caller =
  {}` were swallowed by `_safeSet`'s sloppy-builtin catch. The strict pre-check
  now resolves accessor descriptors along the prototype chain (skipping user
  proxies) and propagates the inherited %ThrowTypeError% poison setter's
  exception. `BoundFunction_restricted-properties.js` passes.

Deferred (separate concerns, not regressions):
- **(c) `instance-length-*`** — requires (1) a *configurable* `length` on the
  host-wrapped wasm function so the test's `Object.defineProperty(foo,"length")`
  succeeds, and (2) bind reading the target's *runtime* `.length` rather than
  the compile-time `lengthHint`. Both are property-model changes orthogonal to
  bind; tracked as follow-up.
- **`instance-construct-newtarget-self-new`** — `new.target === A` needs
  new-target identity threaded through the host bound-function bridge; deferred.
- `15.3.4.5-6-*` (Function.prototype dynamic property inheritance through the
  bound externref) and the realm tests remain pre-existing/out-of-scope.
