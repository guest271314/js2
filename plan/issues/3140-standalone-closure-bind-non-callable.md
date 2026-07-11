---
id: 3140
title: "Standalone: Function.prototype.bind on a closure returns a non-callable — blocks the entire modern test262 TypedArray harness (makeCtorArg)"
status: done
completed: 2026-07-11
assignee: ttraenkler/fable-harvest3
created: 2026-07-11
updated: 2026-07-11
priority: high
task_type: bug
area: codegen, runtime
language_feature: function-bind
goal: standalone
sprint: current
horizon: m
related: [2872, 2860, 2876, 3016]
umbrella: 2860
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
  - src/codegen/registry/types.ts
  - src/codegen/closure-classifier.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
origin: "2026-07-11 — discovered by fable-harvest3 during #2872 slice 1 (dynamic TA construction): every makeCtorArg-style TypedArray test fails at the HARNESS level because argFactory.bind(undefined, constructor) is not callable"
---

## Implemented (2026-07-11, fable-harvest3)

**Root cause (two layers):** (a) the typed `compileFunctionBind` route degraded
to *identity-bind* under standalone (returned the target, DROPPED partial
args — the #1632a documented gap); (b) an `any`-typed receiver (`argFactory`
is an array element — no TS call signatures) never routed there at all: it fell
to the open-object dispatcher arm and returned `undefined`.

**Fix — native `$__bound_fn {target, thisArg, boundArgs}` carrier:**

1. `getOrRegisterBoundFnType` (registry/types.ts), memoized on
   `ctx.boundFnTypeIdx`; byte-inert for bind-free modules.
2. `compileFunctionBind` standalone arm mints the carrier (spec §20.2.3.2
   evaluation order: target → thisArg → partials, each once).
3. Any-receiver `.bind` routes through **reserve-then-fill `__bind_dyn`**
   (object-runtime.ts): the callable gate needs the COMPLETE closure-classifier
   root list, only settled at finalize (#1896 hazard) — callable → mint;
   anything else → the legacy `__extern_method_call(recv, "bind", args)` route
   (undefined), so non-callables keep prior behavior.
4. `fillApplyClosure` gains a `$__bound_fn` front-guard (the #3031 $Proxy
   ladder pattern): unwraps ONE bound layer per hop — merged = boundArgs ++
   args, [[BoundThis]] wins over the caller receiver (§10.4.1.1), recursion on
   the target composes bound-of-bound.
5. `tryEmitInlineDynamicCall` (bare `bound(...)` calls) gains an unwrap arm,
   pre-scanned via `sourceHasBindCall` for compile-order independence.
6. The closure classifier counts the carrier callable → `typeof bound ===
   "function"`, `__is_closure`, typeof-object exclusion — one predicate, all
   consumers.

**Measured (standalone lane, local scans vs pre-fix):**
`built-ins/Function/prototype/bind`: 16 → 27 pass (**+14 / −3**; the 3 flips
are `Object.defineProperty`-on-the-carrier tests that previously passed by the
identity-bind accident). `built-ins/TypedArray/prototype`: unchanged — the
harness's NEXT gate is `Array.from({length}, fn)` / `Array.from(iterable)`
(leaks `__make_callback` / `__array_from`), which is the follow-up lever.

**Residuals (follow-ups):** bound-fn `.length`/`.name` fidelity (carrier
reports arity 0); `Object.defineProperty` on a bound fn; `new bound(...)`
[[Construct]]; the `Array.from` mapper/iterable standalone gap (blocks the
makeCtorArg family — next slice of the #2872/#2860 line).

# Standalone: `fn.bind(...)` on a closure is not callable

## Problem

In `--target standalone`, `Function.prototype.bind` on a compiled closure
returns a value that is not a function:

```ts
function mk(TA: any, x: any) {
  return x;
}
export function test(): number {
  const f: any = mk;
  const bound = f.bind(undefined, 42);
  if (typeof bound !== "function") return 1; // ← returns 1 today
  const r = bound([5, 6]);
  return r.length === 2 && r[0] === 5 ? 9 : 3;
}
```

Compiles host-free, runs, returns `1` (expected `9`).

## Impact — the single biggest blocker for the modern TypedArray harness

test262's `testWithAllTypedArrayConstructors` (the CURRENT
`harness/testTypedArray.js`) drives every `testWithTypedArrayConstructors(f)`
test through per-factory bound functions:

```js
var boundArgFactory = argFactory.bind(undefined, constructor);
f(constructor, boundArgFactory);
```

so EVERY test using the `makeCtorArg` callback param (the majority of
`built-ins/TypedArray/prototype/**` content tests, ~hundreds of files) fails at
the harness level before the tested method even runs — regardless of how much
TA substrate exists (#2872 slice 1 landed general dynamic construction; these
tests still fail solely on `.bind`). Fixing `.bind` multiplies every TA
substrate slice already landed.

## Root cause (to verify)

`.bind` on an `any` receiver holding a native closure struct has no native
arm — it falls to the open-`$Object`/`__extern_method_call` path and returns
undefined/null. The reflective `.call`/`.apply` recovery landed in #2876/#3016
(`__apply_closure` + `emitReflectiveNativeProtoClosureCall`); `.bind` needs the
partial-application analog: allocate a wrapper closure carrying
`{target, boundThis, boundArgs($ObjVec)}` whose invoke path prepends
`boundArgs` and delegates through `__apply_closure`. `typeof` must answer
`"function"` for the wrapper (closure-classifier arm, see
`buildClosureRefTestArms` #3125).

## Acceptance criteria

- [ ] The repro above returns 9 (bound-arg prepend + passthrough, host-free).
- [ ] `typeof bound === "function"`.
- [ ] `bound.call(x, …)` / nested re-bind at least do not trap.
- [ ] Measured: `built-ins/TypedArray/prototype/fill/fill-values-relative-start.js`
      (and the makeCtorArg family) progress past the harness `bind` (they may
      still fail on later factory gaps — `.buffer` accessor, iterables).
- [ ] Zero host-mode regression (standalone/wasi-gated).
