---
id: 2668
title: "ES5: Object.defineProperty/defineProperties descriptor fidelity residual (~788 fails — largest ES5 cluster)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: spec-completeness
related: [1460, 1462, 929]
sprint: 66
---
# #2668 — ES5 Object.defineProperty/defineProperties descriptor fidelity residual

## Edition / impact

- **Edition:** ES5.
- **Fail count:** **~788** — the single largest ES5 cluster.
  - `built-ins/Object/defineProperty`: **506**
  - `built-ins/Object/defineProperties`: **282**
  - (plus tails: `Object/create` 89, `getOwnPropertyDescriptor` 26 — track here too).
- **Highest ES5 bang-for-buck.** Residual after #1460 / #1462 / #929 (all done) —
  those landed core descriptor support; this is the long tail of full
  [[DefineOwnProperty]] spec fidelity.

## Problem

`Object.defineProperty` / `defineProperties` do not fully implement the
ES5/ES2015 9.1.6 `[[DefineOwnProperty]]` / `ValidateAndApplyPropertyDescriptor`
algorithm. The failing tests exercise the validation matrix that the current
implementation handles only partially:

- **Attribute defaulting** when adding a new property (missing attributes
  default to `false`/`undefined`).
- **Reconfiguration rules** on existing properties: non-configurable properties
  may not change configurable/enumerable, may not switch data<->accessor, may
  not change a non-writable data value (with the `SameValue` exception), etc. —
  each illegal change must throw `TypeError`.
- **Array exotic [[DefineOwnProperty]]**: defining `"length"` (RangeError on
  invalid length, deletion of out-of-range indices), defining an index ≥ length
  updating `length`, non-writable `length` blocking index adds.
- **Accessor descriptors**: get/set must be callable-or-undefined; redefinition
  preserves unspecified attributes.
- **Side-effect ordering**: descriptor field reads (`get`, `set`, `value`,
  `writable`, `enumerable`, `configurable`, plus `ToPropertyKey` on the key) in
  the spec-mandated order, each read once.

Failure signatures are dominated by `assert.sameValue(obj.prop, ...)`,
`verifyProperty(...)`, `assert.throws(TypeError/RangeError, ...)`.

## Failing-test cluster (examples)

```
built-ins/Object/defineProperty/15.2.3.6-4-*           (the big 4-* descriptor-matrix family)
built-ins/Object/defineProperty/name.js, length.js, descriptor-*-*.js
built-ins/Object/defineProperties/15.2.3.7-*           (multi-descriptor application + ordering)
built-ins/Object/create/15.2.3.5-*                     (create with property descriptors)
```

## Acceptance criteria

- Target: pass **≥ 600 of the ~788** failing `defineProperty`/`defineProperties`
  tests (full `ValidateAndApplyPropertyDescriptor` matrix).
- All non-configurable-property illegal-change cases throw `TypeError`.
- Array `length` define cases throw `RangeError` on invalid length and update
  `length` correctly on index define.
- Descriptor-field reads occur in spec order, once each.
- No regression in currently-passing Object.* tests.

## Notes — feasibility: hard

This is core property-machinery work and touches the object model; route to the
architect for an implementation spec before dispatch. Likely a focused rewrite
of the shared `[[DefineOwnProperty]]` helper rather than per-method patches.
Consider slicing: (a) data-descriptor matrix, (b) accessor + data<->accessor
switch, (c) Array-exotic length/index. Each slice is independently shippable.
