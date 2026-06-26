---
id: 2706
title: "for-in enumeration order: integer-index keys ascending, insertion-order strings, prototype-chain dedup"
status: ready
sprint: 67
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: ES5
language_feature: for-in
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2706 — for-in enumeration order: numeric-first, insertion-order strings, prototype chain

## Problem

The `for-in` statement does not enumerate object keys in the order required by ECMAScript §13.7.5.15 EnumerateObjectProperties:

**(a) Integer-indexed keys must come first in ascending numeric order, then remaining string keys in property-creation (insertion) order.** `order-simple-object.js` creates an object with properties `b`, `a`, `1`, `2` and expects the for-in output to be `["1", "2", "b", "a"]` — integer indices ascending, then strings in insertion order. We currently emit them in a different order.

**(b) Prototype chain keys: inherited enumerable properties must appear after all own properties, with shadowed/already-visited keys skipped.** `order-property-on-prototype.js` and `S12.6.4_A6.js` / `S12.6.4_A6.1.js` check that properties from the prototype appear after own properties and that shadowed ones are not repeated.

**(c) Properties added via `Object.defineProperty` after object creation must appear in the right position.** `order-after-define-property.js` checks that a property added with `defineProperty` (non-numeric, non-creation-order) still follows the integer-index-first rule.

Spec: ECMAScript §13.7.5.15 EnumerateObjectProperties abstract operation — note the spec deliberately leaves ordering partially unspecified for non-integer-index string keys, but test262 validates the most common conforming ordering (integer indices first, then insertion order, then prototype chain).

## Failing tests (test262 baseline 2026-06-26)

```
test/language/statements/for-in/order-simple-object.js
test/language/statements/for-in/order-property-on-prototype.js
test/language/statements/for-in/order-after-define-property.js
test/language/statements/for-in/S12.6.4_A6.js
test/language/statements/for-in/S12.6.4_A6.1.js
```

## Root cause (suspected)

The for-in enumeration in the runtime (likely a host import or the `__for_in_keys` helper) returns property keys in an arbitrary iteration order (probably whatever JS engine order the host's `Object.keys`/`for...in` gives). It may not:
1. Sort integer-indexed own properties numerically before string own properties.
2. Walk and deduplicate the prototype chain.
3. Preserve insertion order for string keys after the numeric sort.

The fix likely requires either:
- Implementing EnumerateObjectProperties in the Wasm runtime helper (sort integers, preserve insertion, walk proto chain, track seen set), or
- If using a JS host import, ensuring the host-side `__for_in_keys` helper returns keys in the correct canonical order.

Standalone mode must also implement this without relying on JS engine for-in ordering.

## Acceptance criteria

All 5 listed tests flip from fail to pass. No regression in `statements/for-in/` currently-passing tests. Full CI green.

## Notes

- Keep separate from #2705 (for-in lexical scoping — different code path: enumeration key generation vs head/body scoping).
- The ordering requirement is "implementation-defined for string keys" per strict spec reading, but test262 validates the de-facto standard: integer-index ascending, then insertion order, then prototype chain without duplicates. Conforming implementations all follow this pattern.
- If the `__for_in_keys` helper is shared between `for-in` and `for-of` on objects, changes here must not regress `for-of` enumeration.
