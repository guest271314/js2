---
id: 3140
title: "Standalone: Function.prototype.bind on a closure returns a non-callable — blocks the entire modern test262 TypedArray harness (makeCtorArg)"
status: ready
created: 2026-07-11
priority: high
task_type: bug
area: codegen, runtime
language_feature: function-bind
goal: standalone
sprint: current
horizon: m
related: [2872, 2860, 2876, 3016]
umbrella: 2860
origin: "2026-07-11 — discovered by fable-harvest3 during #2872 slice 1 (dynamic TA construction): every makeCtorArg-style TypedArray test fails at the HARNESS level because argFactory.bind(undefined, constructor) is not callable"
---

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
