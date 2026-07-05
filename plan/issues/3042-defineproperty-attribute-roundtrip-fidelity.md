---
id: 3042
title: "Object.defineProperty: attribute round-trip fidelity (writable/enumerable/configurable not faithfully stored + reported)"
status: ready
sprint: current
priority: high
horizon: m
feasibility: medium
created: 2026-07-05
task_type: bugfix
area: runtime, codegen
language_feature: object-defineproperty, property-descriptors
es_edition: 5
goal: spec-completeness
parent: 3022
related: [3022, 1334, 1629]
---

# #3042 — defineProperty attribute round-trip fidelity

Split from the #3022 umbrella (descriptor-fidelity tail). This is the
**developer-scoped, locally-test262-validatable** slice.

## Root cause

After `Object.defineProperty(obj, k, desc)`, reading the property back via
`Object.getOwnPropertyDescriptor` / `verifyProperty` (the test262 helper that
mutates then restores each attribute) reports the wrong **attribute bits**
(`writable` / `enumerable` / `configurable`) or the attributes are not
*enforced* (e.g. a `writable:false` property is still writable, an
`enumerable:false` property still shows in `for-in`). The descriptor-bit sidecar
population at the defineProperty lowering / runtime helper and the
`getOwnPropertyDescriptor` reader do not round-trip faithfully for the common
struct-typed-receiver shapes.

This is the **attribute-fidelity** half of the 600-fail descriptor tail; it is
distinct from value/identity loss (see #3022 note DF-3) and from illegal-
transition validation (#3043).

## Failing files (74, `built-ins/Object/define{Property,Properties}`, `verifyProperty` failures)

`15.2.3.7-6-a-249`, `15.2.3.6-4-79`, `15.2.3.7-6-a-253`, `15.2.3.6-4-243`,
`15.2.3.6-4-81`, `15.2.3.6-4-289`, `15.2.3.7-6-a-215`, `15.2.3.6-4-73`, … (full
set: harvest `verifyProperty` failures under `built-ins/Object/defineProperty`
+ `defineProperties` from `.test262-cache/test262-current.jsonl`).

## Minimal repro

```js
var obj = {};
Object.defineProperty(obj, "foo", { value: 1, enumerable: false });
var d = Object.getOwnPropertyDescriptor(obj, "foo");
// expected: d.enumerable === false, d.writable === false, d.configurable === false
// also: for (var k in obj) — "foo" must NOT appear
```

## Layer to fix

- `src/codegen/object-ops.ts` defineProperty lowering — ensure every descriptor
  bit is recorded (the `_wasmPropDescs` / `definedPropertyFlags` sidecar), for
  both the data and accessor fast paths and the runtime path.
- `src/runtime.ts` `getOwnPropertyDescriptor` reader + enumeration
  (`for-in` / `Object.keys`) — consult the recorded bits.

## Acceptance

- `verifyProperty`-based fails in `built-ins/Object/define{Property,Properties}`
  drop materially (target: the 74 listed → near zero).
- No regression in `Object/{freeze,seal,preventExtensions,getOwnPropertyDescriptor}`.
- Scope: **DEV** — locally validatable via `runTest262File` on the cluster.
