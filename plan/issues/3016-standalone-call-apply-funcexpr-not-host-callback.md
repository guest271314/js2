---
id: 3016
title: "standalone: a func-expr/arrow passed to Function.prototype.call/apply is a VALUE, not a host callback — route to closure-struct, not __make_callback"
status: done
completed: 2026-07-03
assignee: ttraenkler/opus-callapply
sprint: 69
priority: high
horizon: s
feasibility: medium
task_type: bugfix
area: codegen
language_feature: closures, call-apply, standalone
goal: host-independence
related: [2903, 2939, 2940]
created: 2026-07-03
updated: 2026-07-03
origin: "2026-07-03 leak-analysis round-6 residual sole-__make_callback decomposition (dev opus-h). Measured on main @ 9c2633b8b, target standalone, merged report run 28624020153."
---

# #3016 — `.call`/`.apply` func-expr arg is a value, not a host callback

## TL;DR

`isHostCallbackArgument` (`src/codegen/closures.ts`) routes **any**
function-expression/arrow argument of a method call on a non-user-class
receiver to the `__make_callback` host bridge (the `return true` default of the
property-access branch). That includes func-expr args to
`Function.prototype.call`/`apply` — but **`.call`/`.apply` provably never invoke
their arguments as callbacks**; they invoke the _receiver_ with those args as
`thisArg` + forwarded params. So the func-expr is a plain function-object
**value**, and routing it through `__make_callback` leaks an
`env::__make_callback` import that breaks host-free (standalone) instantiation
for no reason.

**Fix (standalone-gated, ~3 lines):** in the property-access branch of
`isHostCallbackArgument`, return `false` (GC closure-struct path) when
`ctx.standalone && (methodName === "call" || methodName === "apply")`.

## Measurement (main @ 9c2633b8b, `target: standalone`, run 28624020153)

The 59 non-Temporal residual sole-`__make_callback` passes are **heterogeneous**
(~10 distinct roots — see "Residual decomposition" below), NOT one bounded fix.
The largest **clean, principled, correct-by-construction** sub-lever is the
`.call`/`.apply` value-arg class. Instrumenting the `__make_callback` emit site
over all 59 wrapped test sources isolated these triggers:

- **RegExp getter `this-val-invalid-obj` ×10** — `get.call(() => {})`: the arrow
  is an invalid-`this` value (the "function object" case of a `this`-brand
  test).
- **Array find-family `.call(undefined, fn)` ×4** — `find`/`findIndex`/
  `findLast`/`findLastIndex`; the predicate is forwarded via `.call`, and
  `ToObject(undefined)` throws before it is consulted.
- **`Array.prototype.shift.call(function(){})` ×1** — func-expr as `this`.

## Result

With the standalone-gated narrowing:

- **14 genuine flips** (leak → host-free pass). All 14 verified `pass` via the
  test262 runner in the standalone lane, and **inject-throw** confirms the
  bodies genuinely execute (an injected `throw` fails the copy — not vacuous).
- **Zero host-free-pass regressions**: all **22** currently-passing standalone
  tests that carry a `.call`/`.apply` func-expr arg still pass with the change
  (this is the full affected class in the merged report, not a sample).
- **Bonus**: `Array.prototype.forEach.call(arr, cb)` / `map.call` — where the
  _receiver_ HOF genuinely invokes `cb` — now compile **host-free** and execute
  correctly (the callback dispatches through the closure struct via
  `__call_fn_N`), rather than leaking.
- **gc/js-host lane byte-identical** (sha256 over representative binaries) — the
  change is gated on `ctx.standalone`.

## Why it can't regress a host-free pass

A func-expr passed to `.call`/`.apply` currently ALWAYS routes to
`__make_callback`, which ALWAYS emits an `env::` import — so every such test is
currently _leaky_ (never a host-free pass). The change can therefore only move
such a test leak → {host-free-pass | host-free-fail}, never regress an existing
host-free pass. The 22/22 re-run confirms none become a fail.

## Residual decomposition (banked — NOT this issue)

The other ~45 of the 59 are separate substrate work, filed here for the next
leak-front session:

- **Iterator.prototype.\* helpers ×18** (`find`/`map`/`filter`/`every`/`some`/
  `forEach`/`reduce`/`flatMap` on iterator objects) — need native helper bodies
  that drive the underlying iterator and invoke the predicate via `call_ref`
  (#2903 sub-front 2). These specific 18 are abrupt-completion edge cases
  (throwing-next / return-forwarding) and many would still fail on semantics
  even with native bodies.
- **`new Proxy(fn, handler)` (Function.prototype.toString) ×6** — Proxy is a
  deferred feature; the func-expr is the proxy target.
- **`Object.getPrototypeOf/getOwnPropertyDescriptor(func-expr)` ×5**,
  **`Array.isArray(func-expr)` ×1**, **`.at(func-expr)` ×2** — func-expr as a
  plain non-invoked value arg to a builtin; a broader "func-expr value arg →
  closure path in standalone" default would cover these but needs wider CI
  validation (each builtin consumes the value differently). Deferred.
- **`Map`/`WeakMap.prototype.getOrInsertComputed(k, fn)` ×2** — new proposal
  method; callback invoked, needs native body.
- **`promise.then(arrow)` ×1** — async/microtask substrate (#2903 sub-front 1).
- Scattered: `String.at`, `Date[Symbol.toPrimitive]` forEach, GeneratorFunction.

## Exact site

`src/codegen/closures.ts`, `isHostCallbackArgument`, property-access branch
(the `methodName` block before the class-method resolution `try`):

```ts
if (ctx.standalone && (methodName === "call" || methodName === "apply")) {
  return false;
}
```

## Acceptance

- Targeted corpus flips host-free: `WebAssembly.Module.imports` carries no
  `env::__make_callback` AND the standalone binary instantiates host-free.
- gc/js-host byte-output unchanged (standalone-gated).
- Full `merge_group` net-positive, zero regression.

## Test Results

`tests/issue-3016.test.ts` — 4/4 pass (getter `.call`, `find.call(undefined,fn)`,
`findIndex.apply`, `forEach.call` host-free + genuine execution). 14/14 real
test262 files pass standalone (inject-throw genuine). 22/22 affected passing
tests still pass. gc-lane sha256 identical.
