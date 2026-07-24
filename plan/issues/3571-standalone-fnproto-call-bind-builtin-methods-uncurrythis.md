---
id: 3571
title: "standalone: Function.prototype.call/apply/bind on builtin methods (uncurryThis/propertyHelper blocker)"
status: ready
created: 2026-07-24
updated: 2026-07-24
priority: high
feasibility: hard
model: fable
task_type: conformance
area: codegen
language_feature: function-dispatch
goal: standalone
sprint: current
horizon: l
parent: 2860
related: [2773, 2984, 2744, 2175]
---

# standalone: `Function.prototype.call`/`apply`/`bind` on builtin methods (uncurryThis / propertyHelper blocker)

## Problem

Under `--target standalone`, invoking a builtin prototype method that has been
**reified as a value and re-dispatched via `Function.prototype.call` / `.apply`
/ `.bind`** fails. The dominant real-world trigger is the test262 harness
`propertyHelper.js`, which builds the "uncurryThis" idiom at include-time:

```js
var __hasOwnProperty     = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
var __propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
```

Calling `__hasOwnProperty(obj, name)` — i.e. `Object.prototype.hasOwnProperty.call(obj, name)`
via the doubly-bound `Function.prototype.call` — throws
`TypeError: Cannot convert undefined or null to object` (the bound builtin
method loses its explicit receiver). A second sub-mode returns a falsy value
instead of throwing, surfacing as `Test262Error: obj should have an own
property <X>`.

This is **shared function-dispatch / method-as-value substrate**, NOT specific
to any one builtin. It surfaces most visibly in every `verifyProperty`
descriptor test (`propertyHelper.js` is included by ~all of them), so it caps
the standalone pass rate across **every** builtin lane at once.

## Measured evidence (2026-07-24, current main fa2b189, `--target standalone`)

Measured over the Map/Set/WeakMap/WeakSet/Symbol lane (933 test262 files via
the real runner). **109 of 217 failures** in this lane trace to this single
path (error: `Cannot convert undefined or null to object` /
`Cannot access property on null or undefined`):

| family  | tests in cluster |
| ------- | ---------------- |
| Symbol  | 39               |
| Map     | 23               |
| Set     | 23               |
| WeakMap | 8                |
| WeakSet | 6                |
| MapIter | 5                |
| SetIter | 5                |
| **sum** | **109**          |

Spot-checked one `convert-null` file per family (incl. `Symbol/species/basic.js`,
`Set/prototype/add/add.js`, `Symbol/match/prop-desc.js`): all route through
`propertyHelper.js` → `verifyProperty` → the uncurryThis path. No buried
lane-specific slice — this is genuinely one shared cause. The same lane's
descriptor tests that DON'T hit this path already pass (native Map/Set wiring
landed in #1103).

## Root-cause isolation (primary evidence)

Direct repro under `target: "standalone"` (compiler bundle; note the ad-hoc
harness is imperfect for pass/fail but faithful for the throw):

- `const u = Function.prototype.call.bind(Object.prototype.hasOwnProperty)` —
  **creating** the bound fn succeeds (`typeof u === "function"`).
- `u({a:1}, "a")` — **throws** (`Cannot convert undefined or null to object`),
  even on a plain object — so it is not proto-object-model-specific.
- `u = Function.prototype.call.bind(userFn); u(recv, arg)` — also throws.
- By contrast `userFn.bind(recv)(arg)` **works** — plain `.bind` is fine; the
  break is `.call`/`.apply` (and `call.bind`) threading an explicit receiver
  into a reified/bound method.

The mechanism (why the receiver is dropped) is **hedged** — it needs a
Fable-tier look at the funcref-wrapper / method-as-value dispatch. This is the
same family dev-std-6 flagged as "Array.prototype.map not callable as a value"
and is Fable-gated (cf. #2773 value-rep, #2984, #2744).

## Acceptance criteria

- `Function.prototype.call(thisArg, ...args)` / `.apply(thisArg, argsArray)` on
  a reified builtin prototype method dispatches with the explicit receiver.
- `Function.prototype.call.bind(builtinMethod)` (uncurryThis) produces a
  function that, when invoked, threads its first arg as the method receiver.
- `propertyHelper.js`'s `__hasOwnProperty` / `__propertyIsEnumerable` work
  under standalone → the ~109-test descriptor cluster (this lane) plus the
  cross-lane equivalents flip toward host parity.

## Notes

- SUBSTRATE / fable-tier — do NOT harvest as a dev slice.
- High leverage: this is a cross-cutting standalone lever alongside #2773 /
  #2984 / #2744, registered by the coordinator for the Fable session.
- Discovered while measuring the Map/Set/WeakMap/WeakSet/Symbol standalone lane
  (2026-07-24). Contained slices in that lane (WeakMap/WeakSet iterable ctor,
  Symbol.matchAll whitelist, Set host-leak wiring) are being harvested
  separately.
