---
id: 2739
title: "for-in does not enumerate setPrototypeOf / constructor-prototype-chain properties; Object.defineProperty ordering"
status: ready
sprint: Backlog
goal: test262-conformance
feasibility: hard
depends_on: []
priority: high
es_edition: ES5
language_feature: for-in
task_type: bug
created: 2026-06-27
updated: 2026-06-27
---
# #2739 — for-in prototype-chain + defineProperty enumeration

## Problem

`for-in` over a shape-inferred struct does **not** enumerate properties reached
through a runtime prototype link, and `Object.defineProperty` perturbs creation
order. Split out of #2706/#2731 — these are NOT the delete/re-add asymmetry (that
is #2731, landed via PR #2170); they are a distinct prototype/defineProperty
enumeration bug class. Verified (host mode, current main):

**(a) `Object.setPrototypeOf` chain not walked.**

```ts
var proto = { p4: 'p4' };
var o = { p1: 'p1', p2: 'p2', p3: 'p3' };
Object.setPrototypeOf(o, proto);
for (var k in o) …          // yields "p1,p2,p3" — proto's "p4" is MISSING
                            // (expected ['p1','p2','p3','p4'])
```

**(b) Constructor-function `prototype` chain not walked, with own-shadows-proto.**

```ts
function FACTORY(){ this.prop = 1; this.hint = "hinted"; }
FACTORY.prototype = { feat: 2, hint: "protohint" };
var __instance = new FACTORY;
for (key in __instance) …   // must visit own prop/hint AND inherited feat,
                            // with own hint shadowing proto hint; currently
                            // throws / drops inherited keys
```

**(c) `Object.defineProperty` must not reorder creation order.**

```ts
var obj = {}; obj.a = 1; obj.b = 2;
Object.defineProperty(obj, "a", { value: 11 });
for (var k in obj) …        // must stay ["a","b"] (define does not re-create)
```

Spec: §13.7.5.15 EnumerateObjectProperties — after own keys (OrdinaryOwnPropertyKeys
order), walk `[[GetPrototypeOf]]` and visit each level's enumerable own keys,
skipping any already-visited (shadowed) key.

## Failing tests (test262 baseline)

```
test/language/statements/for-in/order-property-on-prototype.js   (a)
test/language/statements/for-in/S12.6.4_A6.js                    (b)
test/language/statements/for-in/S12.6.4_A6.1.js                  (b)
test/language/statements/for-in/order-after-define-property.js   (c)
```

## Root cause (suspected) — for the architect

`__for_in_keys` (`src/runtime.ts`) already has a manual prototype-chain walk
(`Object.getPrototypeOf(current)`), but for a shape-inferred WasmGC struct:
- `Object.setPrototypeOf(struct, proto)` likely sets a host-side proto link that
  `Object.getPrototypeOf(struct)` in the walk does NOT observe (the struct's
  native `[[Prototype]]` is not the user `proto`), so the proto level is never
  visited.
- A constructor-function (`function FACTORY(){…}; FACTORY.prototype = {…};
  new FACTORY`) builds an instance whose prototype is the function's `.prototype`
  object — the runtime must link the instance to that prototype object so the
  for-in walk reaches `feat`, with `hint` shadowing.
- `defineProperty` ordering: `__object_keys`/`__for_in_keys` must treat a
  `defineProperty` on an EXISTING key as not re-creating it (no reorder).

This needs a coherent prototype-link model for shape-inferred structs +
`Object.getPrototypeOf` consistency in the for-in walk — architect-scope, and a
sibling of #2706's remaining "prototype-chain dedup" goal.

## Acceptance criteria

The 4 tests above flip fail→pass. No regression in `statements/for-in/`. Host
mode (the standalone prototype-link model is a separate sub-case). Full CI green.

## Notes

- Split from #2706 / #2731 (esch, 2026-06-27). #2731 (PR #2170) closed only
  `order-simple-object` (the delete/re-add half); #1830 (PR #2160) closed the
  integer-index half. These 4 are the remaining prototype/defineProperty half.
- Route to **architect** for a prototype-link spec. Overlaps #2706's
  "prototype-chain dedup" scope and the #2580/#2660 substrate.
