---
id: 1694
title: "Promise.any/all/allSettled/race: non-Promise capability `this` + extends-Promise codegen (~50 fails)"
status: backlog
created: 2026-05-28
updated: 2026-06-03
revalidated: 2026-06-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: promises, subclassing
goal: spec-completeness
sprint: Backlog
needs_architect_spec: true
related: [1368, 1465, 1528, 1116, 1644, 1682, 1596, 1632b]
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

## Re-validation (2026-06-03, senior-developer) — scope SHRANK; one tractable runtime fix remains

Re-probed every fingerprint against **current main** (JS-host, real `compile()` →
`WebAssembly.compile(binary)` → `instantiate(mod, importObject)` two-step; the
one-step `instantiate(binary, …)` form races the lazy `importObject` getter and
gives false "no export" failures — that artifact caused several wrong readings in
prior runs). Two of the four original sub-clusters are **now fixed** on main;
only one genuine gap and one tractable runtime guard remain.

| Shape | Source | Current-main result |
|---|---|---|
| **B** `class X extends Promise {}; X.all([…])` | static-method on declared subclass | **RESOLVES** `[1,2]` — already fixed (matches #206 finding, still holds) |
| **A.ii** `Promise.all.call(Sub, […])` where `Sub extends Promise` (declared) | `.call` thisArg = declared subclass | **RESOLVES** `[1,2]` — **now fixed**. WAT confirms codegen routes the thisArg through `__promise_subclass_ctor` (calls.ts:5303→945); native V8 handles `Promise.all.call(syntheticSubclass, realArray)` correctly. Likely closed by #1596 + #1682 landing after the 2026-05-28 investigation. The earlier "callCount stays 0 / null thisArg" reading was a harness artifact. |
| **A.i** `Promise.all.call(NotPromise, […])` where `NotPromise` is a compiled Wasm function | `.call` thisArg = wasm fn used as capability ctor | **THROWS** `TypeError: [object Object] is not a constructor`. `_wrapForHost` (runtime.ts:3592) wraps Wasm structs as a non-callable/non-constructible `Object.create(null)` proxy — no `apply`/`construct` trap. V8's `Construct(C, [executor])` (NewPromiseCapability step) rejects it. **Genuinely architect-blocked** on a host-callable+constructible compiled-fn representation (the #1632b bound-fn-rep umbrella). |
| **ctx-non-object** `Promise.all.call(undefined, [])` | non-object capability `this` | **Returns `1`** instead of throwing `TypeError`. Native V8 throws `Promise.all called on non-object` (§27.2.4.X step 2: `If Type(C) is not Object, throw TypeError`). The compiled `.call(undefined, …)` does not surface that throw. **Tractable runtime/codegen fix** (the §-step-2 guard), independent of the host-callable blocker. |

### Net assessment

The original ~50-fail estimate over-counts. B (~28) and A.ii (~20) are resolved
on current main. What remains:

1. **A.i — architect-blocked.** Needs the compiled-Wasm-function host
   representation to be `[[Call]]` + `[[Construct]]` capable (a `_wrapForHost`
   variant whose target is a `function`/`Proxy` with `apply`+`construct` traps
   dispatching through `__call_fn_N`). This is the same gap as #1632b /
   #1596-residual and should be specced once, centrally — not patched in the
   Promise layer. Keep `needs_architect_spec` for this half.

2. **ctx-non-object — tractable, NOT architect-blocked.** The §27.2.4.X step-2
   `Type(C) is not Object → TypeError` guard isn't surfacing for a non-object
   capability `this`. This is a focused runtime (`_resolveCtor`) + arg-coercion
   fix worth carving as its own small issue; it covers the
   `ctx-non-object` / `ctx-non-ctor` test262 families across all four
   combinators without touching the host-callable representation.

**Recommendation:** carve #1694 into (a) the A.i architect spec (host
fn/class constructible representation — fold into #1632b) and (b) a small
`fix(promise-combinator ctx-non-object guard)` issue. The combinator code
itself (`_resolveCtor` / `Promise.METHOD.call(C, _toIterable(arr))`) is
otherwise spec-correct for the cases that have a usable `C`.
