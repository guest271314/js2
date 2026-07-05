---
id: 3043
title: "Object.defineProperty: ValidateAndApplyPropertyDescriptor illegal-transition rules not enforced (should-throw + SameValue + false-positive Cannot-redefine)"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
created: 2026-07-05
task_type: bugfix
area: runtime
language_feature: object-defineproperty, property-descriptors
es_edition: 5
goal: spec-completeness
parent: 3022
related: [3022, 3042, 1334, 1629]
---

# #3043 — defineProperty illegal-transition validation

Split from the #3022 umbrella. **Senior-scoped** (Fable-reserved): spec-precise
`ValidateAndApplyPropertyDescriptor` (ECMA-262 §10.1.6.3) with blast radius
across `defineProperty` / `freeze` / `seal` / `Object.create`.

## Root cause

Two failure directions, same validate step:

1. **Should-throw, doesn't (80 fails).** Redefining a **non-configurable**
   property in a way the spec forbids must throw `TypeError`, but our impl
   silently applies it:
   - changing `value` of a non-configurable, non-writable data property
     (with the `SameValue` rule: `+0`/`-0` differ, `NaN`/`NaN` are same —
     e.g. `15.2.3.7-6-a-46`),
   - toggling `enumerable` / `configurable`,
   - data ↔ accessor conversion on a non-configurable property.
2. **False-positive `Cannot redefine property` (~13 fails).** A **configurable**
   property that the spec permits to be redefined is wrongly rejected
   (`15.2.3.6-4-293-{1,3}`, `15.2.3.7-6-a-75`).

## Failing files (36 primary + Cannot-redefine cluster)

`15.2.3.7-6-a-245`, `15.2.3.7-6-a-46`, `15.2.3.6-4-293-3`, `15.2.3.7-6-a-93-3`,
`15.2.3.7-6-a-75`, `15.2.3.7-6-a-76`, `15.2.3.7-6-a-81`, `15.2.3.7-6-a-77`, …
(harvest `Expected TypeError` + `Cannot redefine property` under
`built-ins/Object/defineProperty{,ies}`).

## Minimal repro

```js
var obj = {};
Object.defineProperty(obj, "foo", { value: +0 });          // configurable:false (default)
// spec: SameValue(+0, -0) === false ⇒ this is a change on a non-writable,
// non-configurable prop ⇒ must throw TypeError:
Object.defineProperty(obj, "foo", { value: -0 });
```

## Layer to fix

`src/runtime.ts` (and/or `src/codegen/object-ops.ts`) — the descriptor
validate/apply step: implement the full §10.1.6.3 rejection matrix + `SameValue`
comparison; ensure the configurable-redefine path does not over-reject.

## Why senior

Changes flow into `freeze`/`seal`/`preventExtensions` and every descriptor
consumer; the +0/-0/NaN `SameValue` edges are subtle. **Must validate IN BATCH
(full CI / merge_group), not a scoped sweep.**

## Acceptance

- Illegal non-configurable transitions throw `TypeError`; legal configurable
  redefinitions succeed. No regression in `freeze`/`seal`/`create`.
