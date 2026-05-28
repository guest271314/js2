---
id: 1694
title: "Promise.any/all/allSettled/race: non-Promise capability `this` + extends-Promise codegen (~50 fails)"
status: backlog
created: 2026-05-28
updated: 2026-05-28
investigation_done: 2026-05-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: promises, subclassing
goal: spec-completeness
sprint: Backlog
related: [1368, 1465, 1528, 1116, 1644, 1682, 1596, 1632b]
needs_architect_spec: true
---
# #1694 — Promise combinators: non-Promise capability `this` + extends-Promise codegen

## Problem

Across `Promise.any`, `Promise.all`, `Promise.allSettled`, `Promise.race`, ~50
test262 cases fail with two distinct error fingerprints that share the same
underlying gap: the **NewPromiseCapability(C)** step of each combinator
(§27.2.4.1 step 3 / §27.2.4.3 step 3 / §27.2.4.2 step 3 / §27.2.4.5 step 3) is
not honoured when `C` is anything other than the host `Promise` constructor.

### Sub-cluster A — non-Promise capability `this` (~40 fails, ~10 per method)

```js
Promise.any.call(NotPromise, [1])
//  → "[object Object] is not a constructor"
//  expected: NotPromise(executor) is called, resolving capability
```

Test262 `built-ins/Promise/{any,all,allSettled,race}/capability-executor-not-callable`,
`ctor-poisoned-then`, `capability-resolve-throws-no-close`, `species-constructor`
families. The combinator implementations in `src/runtime.ts` hard-wire
`new Promise(...)` instead of constructing through the actual `C` receiver, so
any non-`Promise` `this` value (including user functions and subclasses with a
custom `Symbol.species`) is rejected by V8 at the `new C(executor)` step inside
our host glue.

### Sub-cluster B — `class X extends Promise` codegen invalid (~7 per method, ~28 fails)

```
class X extends Promise {}
X.any([])
//  Compiling function #N failed: extern.convert_any[0] invalid Wasm
```

Test262 `built-ins/Promise/{any,all,allSettled,race}/resolve-from-same-constructor`,
`promise-resolve-function-from-same-constructor` families. The user-defined
`extends Promise` produces invalid Wasm at compile time: the `extern.convert_any`
operand stack does not match — the synthetic derived constructor returns an
externref-shaped value where the parent path expects the host Promise externref,
and the cast is emitted against an empty / wrong-type top-of-stack.

Cross-references:
- Builtin-parent derived-ctor super wiring (#1682, fixed for WeakMap/Promise/Object)
  was the localized fix for the **constructor** half; **the static combinator
  half is not covered**.
- `__bind_function` / bound-function representation (#1632a, #1632b) is adjacent
  — the codegen path that produces the wrong-type operand for `extern.convert_any`
  here may share code with the bound-function representation issue.

## Decomposition

| Sub-cluster | Tests | Per method | Root cause | Feasibility |
|---|---|---|---|---|
| A — non-Promise capability `this` | ~40 | ~10 | combinators hard-wire `new Promise(...)`; ignore `C` | medium |
| B — `class X extends Promise` static-method | ~28 | ~7 | derived-class static codegen emits `extern.convert_any[0]` with invalid stack | hard |

## Acceptance criteria

1. `Promise.any.call(F, [1])` invokes `F` as the capability constructor (no
   `[object Object] is not a constructor`) — same for `all`, `allSettled`,
   `race`. ~40 tests pass.
2. `class X extends Promise {}; X.any([])` compiles to valid Wasm (no
   `extern.convert_any[0] invalid Wasm` at compile time) and resolves through
   `X.[[Construct]]`. ~28 tests pass.
3. Combined pass-rate for `built-ins/Promise/{any,all,allSettled,race}` rises
   by ~50.

## Files to investigate

- `src/runtime.ts` — `__promise_any`, `__promise_all`, `__promise_allSettled`,
  `__promise_race` host bridges (NewPromiseCapability call site).
- `src/codegen/class-bodies.ts` — derived-class static-method codegen
  (where the bad `extern.convert_any` originates for Sub-cluster B).
- `src/codegen/expressions/calls.ts` — `.call(ThisArg, ...)` dispatch on
  static Promise methods (Sub-cluster A's user-call site).

## Why this is hard

Sub-cluster B intersects three known-hard areas already documented:
- Derived-class constructor representation across builtin parents (#1682
  delivered Half A; Half B was architect-blocked).
- Bound-function / function-as-host-callable representation (#1632a/b, #1596).
- The `extern.convert_any` operand-stack mismatch surfaces in roughly the same
  shape as #1623-extern.

Sub-cluster A is the simpler half — rewrite each `__promise_*` to call
`new C(executor)` via the supplied `this` instead of hard-coded `Promise` —
but verifying spec invariants (capability resolve/reject identity, abrupt
completion ordering) is non-trivial and overlaps with #1368 (resolver-element
spec gap) and #1465 (combinator iterable subclass).

## Related

- #1368 — `resolveElementFunction` / `resolveAndRejectElementFunctions` spec gap
- #1465 — combinator iterable-subclass behaviour
- #1528 — non-constructor TypeError + `Symbol.species` on Promise
- #1116 — Promise resolution + async error handling (parent umbrella)
- #1644 — BigInt rep spec (precedent for "needs architect rep decision")
- #1682 — derived-ctor super-must-be-called for builtin subclasses (Half A
  shipped, Half B architect-blocked)

## Investigation (2026-05-28, senior-developer) — RE-DECOMPOSED, NEEDS ARCHITECT SPEC

Probed each fingerprint against current main with `tests/probe-1694*.test.ts`
(JS-host mode, real `compile()` + `WebAssembly.instantiate()`). The issue's
original decomposition is **partially incorrect** and the failures span THREE
distinct root causes, only one of which is in any way a Promise-layer fix.

### Finding 1 — original Sub-cluster B "`X extends Promise` static codegen
emits `extern.convert_any[0] invalid Wasm`" is **already fixed on main**.

Probe (`tests/probe-1694b.test.ts`): `class MyPromise extends Promise<any>;
MyPromise.{any,all,allSettled,race}([...])` compiles and instantiates without
error. The `isPromiseSubclassReceiver` branch in
`src/codegen/expressions/calls.ts:4916-4932` correctly walks
`classBuiltinParentMap` (populated by `class-bodies.ts:201-204` for any class
whose parent is in `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`, which includes
`Promise`), then routes to `__promise_subclass_ctor` via
`resolvePromiseSubclassThisArg` (calls.ts:717-756). No Wasm validation error
ever fires for the direct-subclass form. The ~28 fails attributed to "invalid
Wasm at compile time" in the issue body do not reproduce. **No codegen patch
is owed at this layer.**

What I observed in MY first probe — `(MyPromise as any).any([])` returning
`Cannot read properties of null (reading 'any')` — is a different gap: the
`as any` TS cast wraps the identifier in `AsExpression`, so
`ts.isIdentifier(propAccess.expression)` at calls.ts:4917 is false and the
subclass-receiver detection skips. Dropping the cast (probe B) shows the
direct form works. test262 never writes `as any`; this is a probe artifact.

### Finding 2 — original Sub-cluster A "non-Promise capability `this`"
decomposes into two *very* different sub-failures with different root causes:

**A.i — `Promise.X.call(plainFunction, [...])`** (the `capability-*-not-callable`,
`ctor-poisoned-then`, `capability-resolve-throws-no-close` family,
~6/method ≈ ~24 fails):

```js
function fn1(executor) { ... }
Promise.any.call(fn1, []);
//  observed: TypeError: [object Object] is not a constructor
//  expected: fn1 invoked as `new fn1(executor)`; the resulting promise's
//            resolve/reject is then checked for IsCallable (spec §27.2.1.5)
```

Root cause: `fn1` is a Wasm-compiled function. Codegen passes its
`_wrapForHost` *object* into the `Promise_any` import as the `thisArg`
externref. `Promise.any.call(C, ...)` in the host runs the spec's
`NewPromiseCapability(C)` step 7 — `Construct(C, [executor])` — which V8
implements as `new C(executor)`. The wrapped Wasm function reaches V8 as a
plain object that is not [[Construct]]-able. **This is literally the same
root cause as #1596** (`Function.prototype.apply/.call on compiled Wasm
functions`) and #1632b (bound-function representation): the wasm-compiled
function is not exposed to the host as a callable/constructible value.

**A.ii — `Promise.X.call(declaredSubclass, [...])`** (the `ctx-ctor.js`,
`resolve-from-same-constructor.js`, `species-constructor.js` family,
~5/method ≈ ~20 fails):

```js
class SubPromise extends Promise {
  constructor(a) { super(a); callCount += 1; executor = a; }
}
Promise.any.call(SubPromise, []);
//  observed: no throw, but callCount === 0 AND typeof executor === 'object'
//  expected: callCount === 1 AND typeof executor === 'function'
```

Root cause: `__promise_subclass_ctor(name)` (`src/runtime.ts:6386-6405`)
returns a *bodyless* `class extends Promise {}` synthesized in the host.
That synthesized class has no user-body, so V8's `new C(executor)` runs the
user's source-level `SubPromise` constructor NOT AT ALL. The user-recorded
side effects (incrementing `callCount`, capturing the executor reference)
never happen. The synthesized class' name is even patched at runtime to
match the source name, which makes `instance.constructor === SubPromise`
*also fail* in test262 (the JS subclass object is not identity-equal to the
compiled `SubPromise` class binding the source identifier resolves to).

This is **not** fixable inside `__promise_subclass_ctor`: bridging the
synthesized JS subclass body back to the user's compiled-Wasm constructor
body is the same architectural gap as #1682 Half B (derived-ctor return
shape across builtin parents) and the bound-function representation #1632b.
Without a callable representation for compiled functions/classes, the host
cannot delegate construction to user code.

### Decomposition (corrected)

| New sub-issue | Tests | Root cause | Blocking issue |
|---|---|---|---|
| #1694A.i — `Promise.X.call(wasmFunction, …)` capability ctor | ~24 | wasm-compiled function not host-constructible | **#1596** (apply/call on compiled wasm fns), **#1632b** (bound-fn rep) |
| #1694A.ii — `Promise.X.call(declaredSubclass, …)` runs synthesized ctor only | ~20 | `__promise_subclass_ctor` bodyless; cannot bridge to user constructor | **#1682 Half B** (derived-ctor representation), **#1632b** |
| #1694B — `X extends Promise; X.METHOD(...)` direct-subclass | 0 (works) | (none — already routed via `resolvePromiseSubclassThisArg`) | — |

### Recommendation

**Close #1694 as NEEDS-ARCHITECT-SPEC, blocking on #1596 + #1632b + #1682.**

No Promise-layer code change moves the needle:

1. The Promise combinator bridges already pass the correct `thisArg` /
   `directCall` triple to V8 via `Promise.X.call(C, …)`. The bug isn't in
   the combinator logic; it's that the `C` reaching V8 is either a
   non-constructible wasm-fn wrapper (A.i) or a bodyless synthesized JS
   subclass that drops the user constructor (A.ii).
2. Both require the same upstream architect decision: **how does a
   compiled-Wasm function/class get exposed to the host as a callable AND
   [[Construct]]-able value whose `[[Call]]` / `[[Construct]]` invoke the
   user's compiled body?** Today the answer is "it doesn't" — wasm fns
   reach the host as opaque `_wrapForHost` objects, and class identifiers
   that have no class-object singleton reach the host as `null` /
   synthesized-stub.

When #1596 + #1632b + #1682-Half-B land (or whichever ones address the
"host-callable / host-constructible compiled-Wasm thing" representation),
re-run the Promise.{any,all,allSettled,race} suites. Cluster A.i unblocks
when wasm fns are host-callable+constructible; cluster A.ii unblocks when
the synthesized subclass bridge can chain through to the user constructor
body. Both should resolve for free at the Promise layer.

### Probe shapes (reproducible — see commit message for the verbatim
sources; probes intentionally not committed because the `tests/probe-*.test.ts`
gitignore pattern is the project convention for ad-hoc investigation files)

| Shape | File pattern | Result on main |
|---|---|---|
| `(MyPromise as any).any([…])` | identifier wrapped in `AsExpression` | null-receiver throw — *probe artifact*, doesn't reproduce in test262 |
| `MyPromise.any([…])` (direct subclass static) | bare identifier | passes — `resolvePromiseSubclassThisArg` fires |
| `Promise.any.call(fn1, [])` (fn1 = wasm fn) | `.call()` plus wasm-fn thisArg | `TypeError: [object Object] is not a constructor` — **A.i**, root in #1596/#1632b |
| `Promise.any.call(SubPromise, [])` (declared subclass) | `.call()` plus declared subclass | runs but `callCount===0` / executor not captured — **A.ii**, root in #1682-B/#1632b |

No source code was changed in this branch — this issue resolves at the host-
callable / host-constructible representation layer, not in the Promise
combinator code.
