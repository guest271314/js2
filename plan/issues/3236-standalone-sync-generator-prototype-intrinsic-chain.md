---
id: 3236
title: "standalone: native sync generator-prototype intrinsic chain — retire env::__get_generator_function_prototype / __get_generator_prototype (13 sole leaks)"
status: in-progress
sprint: current
priority: medium
feasibility: hard
reasoning_effort: max
task_type: substrate
area: codegen
language_feature: generators, intrinsics, prototype-chain, standalone
goal: host-independence
umbrella: 1781
assignee: ttraenkler/opus-leak
related: [3235, 1516, 1639, 3013, 2901]
origin: "2026-07-13 standalone sole-import leak ranking (opus-leak), #2 bounded cluster after #3235. 13 sole leaks: 8 __get_generator_function_prototype + 2 __get_generator_prototype + 3 combined."
---

# #3236 — native sync generator-prototype intrinsic chain (standalone)

## Problem

In standalone mode, `Object.getPrototypeOf(genFn)` and `genFn.prototype` route
through the host imports `env::__get_generator_function_prototype` /
`env::__get_generator_prototype` and, when the host is unavailable, **fall
through to a legacy `ref.null.extern`** (see the "fall through to legacy null
path" comments). That leaks the import (host lane) or returns a wrong `null`
(standalone). 13 standalone leaky-pass entries have these as their **sole**
import:

- `language/statements/generators/prototype-relation-to-function.js`
- `language/statements/generators/default-proto.js`
- `built-ins/GeneratorPrototype/{next,return,throw}/property-descriptor.js`
- `built-ins/GeneratorPrototype/{next,return,throw}/this-val-not-object.js`
- (+ `__get_generator_prototype` combined cases)

### Spec chain (ES2025 §27.3–27.5)

```
genFn ──getPrototypeOf──▶ %Generator% (= %GeneratorFunction.prototype%, §27.3.3)
                            [[Prototype]] = %Function.prototype% (§27.3.3.2)
                            .prototype (own, w:F e:F c:F) = %GeneratorPrototype%
genFn.prototype ─────────▶ %GeneratorPrototype% (§27.5.1)
                            [[Prototype]] = %IteratorPrototype%
                            own next/return/throw (w:T e:F c:T), each brand-checked
gen() (instance) ─proto──▶ %GeneratorPrototype%  (default-proto.js, even after
                            `genFn.prototype = null`)
```

## Substrate primitives available (standalone)

- `__new_plain_object() -> externref`
- `__object_create(proto externref) -> externref` (OrdinaryObjectCreate, §20.1.2.2)
- `__obj_define_from_desc(target, key, desc) -> externref` (define own prop w/ descriptor)
- native singleton pattern: `emitArrayIteratorPrototypeSingleton`
  (array-object-proto.ts) — lazy global + `ref.is_null` init guard
- native generator brand-check: `emitBrandCheckTypeError` (generators-native.ts)
  — currently emitted INLINE at `GeneratorPrototype.next.call(x)` sites, not as
  a first-class stored method value

## Call sites to rewire (standalone-gated; host lane keeps the import)

- `src/codegen/expressions/calls.ts` ~7859 — `Object.getPrototypeOf(genFn)` →
  emit native `%Generator%` singleton instead of null fallthrough.
- `src/codegen/property-access.ts` ~4866 / ~4975 — `genFn.prototype` → emit
  native `%GeneratorPrototype%` singleton instead of null fallthrough.

## Slice plan (multi-PR — this is a real substrate, not a gate)

- **Slice 1** (this PR target): native `%IteratorPrototype%` / `%GeneratorPrototype%`
  / `%Generator%` / `%Function.prototype%` singletons with correct `[[Prototype]]`
  links + descriptor-carrying own `next`/`return`/`throw` (as brand-checked
  first-class closure values) on `%GeneratorPrototype%`; wire
  `Object.getPrototypeOf(genFn)` → `%Generator%` and `genFn.prototype` →
  `%GeneratorPrototype%`. Flips: `prototype-relation-to-function.js` +
  `GeneratorPrototype/{next,return,throw}/{property-descriptor,this-val-not-object}.js`
  (7 of the 8 `__get_generator_function_prototype` sole entries).
- **Slice 2**: `default-proto.js` — native generator INSTANCE `Object.getPrototypeOf`
  must return the same `%GeneratorPrototype%` singleton by identity (deep coupling
  into the native generator instance model, generators-native.ts).
- **Slice 3**: `__get_generator_prototype` combined + any residual multi-import
  entries.

## Acceptance (Slice 1)

- `Object.getPrototypeOf(genFn)` and `genFn.prototype` compile host-free (no
  `__get_generator_*` import) in standalone; JS-host lane byte-identical.
- `getPrototypeOf(getPrototypeOf(g)) === getPrototypeOf(f)` (both `%Function.prototype%`).
- `GeneratorPrototype.next/return/throw` present with `{w:T,e:F,c:T}` and throw
  TypeError on non-object `this`.
- NET ≥ 0 on the merge_group standalone floor.
