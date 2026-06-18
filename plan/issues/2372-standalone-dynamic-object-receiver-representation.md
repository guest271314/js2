---
id: 2372
title: "standalone: force dynamic-object-receiver vars onto $Object representation (the dynamic-object family unblock)"
status: ready
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: objects, property-descriptors, representation
goal: standalone-mode
related: [1906, 2371, 1629a, 1629b, 1630, 1355, 1472, 1673]
blocks: [2371, 1355, 1629b]
arch_scale: true
---

# #2372 — receiver-representation unblock for the standalone dynamic-object family

> **Single highest-leverage remaining architect item for standalone.** This one
> representation change gates the WHOLE dynamic-object-receiver family:
> `Object.defineProperty` (~235), `Object.create(proto, props)`,
> `Object.getOwnPropertyDescriptor` (#1629b read-back),
> `Object.seal`/`freeze`/`preventExtensions` (#1355 family). Worth a deliberate
> dedicated effort — NOT a session-tail force.

## Problem (the wall)

A `const o: any = {}` (or `var o = {}`) receiver is compiled to a **typed
WasmGC struct**. When such a variable is later the target of a dynamic
property operation — `Object.defineProperty(o, k, descVar)`,
`Object.create(...)`-derived, `o[k] = v` with a runtime key, descriptor
reflection — the *write* goes into the native `$Object` open-hash-map runtime
(`__obj_insert` / `__defineProperty_value` / `__defineProperty_accessor`, all
landed), but the *read* (`o.foo`, `o.hasOwnProperty("foo")`) lowers to
`struct.get` against the typed struct. The struct and the `$Object` are
**different objects**, so the write is invisible to the read.

**Proven** (#2371 spike, 2026-06-19): on a receiver that IS already a `$Object`
(`Object.create(null)`), a dynamic **data** descriptor reads back correctly
(`o.x === 7`) AND a dynamic **accessor** descriptor reads back correctly
(`o.x === 9`). So define + read-back already COMPOSE on a `$Object`. The only
missing piece is putting the receiver on the `$Object` representation. That is
why #2371's correct native define banks 0 test262 alone.

## Fix direction (declaration-time receiver forcing)

Mirror the existing accessor-literal precedent: `initIsAccessorLiteral`
(`src/codegen/index.ts:~12698`) already forces a var to `externref` +
tags `ctx.externrefAccessorVars` BEFORE allocating its local slot, so reads
route through `__extern_get` / the `$Object` path. Extend that pre-pass:

1. **Scan the enclosing function/module body** for the var being a target of a
   dynamic-object op: `Object.defineProperty(<ident>, …)`,
   `Object.defineProperties(<ident>, …)`, assignment from
   `Object.create(<proto>, <props>)` / `Object.create(<proto>)`,
   `Object.seal/freeze/preventExtensions(<ident>)`, and runtime-keyed
   `<ident>[expr] = …`. (Several of these already have narrower hooks —
   `markRuntimeDefinedProperty`, `sidecarDefinedPropertyKeys`,
   `definedPropertyFlags` — but they fire at the WRITE site, AFTER the struct
   slot is allocated, so they cannot retype the receiver.)
2. When detected, force the var to `externref` + tag `externrefAccessorVars`
   (or a new `dynamicObjectVars` set) at declaration time, BEFORE `allocLocal`,
   exactly like the accessor-literal arm.
3. **Un-gate the read hook for data descriptors**: `runtimeAccessorDescriptorKey`
   (`property-access.ts:239`) currently requires `DESCRIPTOR_FLAG_ACCESSOR`;
   data-descriptor defined keys on a forced-`$Object` receiver should also route
   to `emitRuntimeDescriptorGet` / the `$Object` read path. (Once the receiver
   is `$Object`, the plain property-access `$Object` arm already handles data
   reads — the create(null) spike returned 7 without touching this hook — so
   this step may be unnecessary for the bare read but is needed for descriptor
   reflection.)

## The risk (call this out loudly)

Forcing a receiver var off the typed-struct representation **re-types it**, and
risks regressing the **typed-struct fast path for class instances** (the #1673
class-receiver hot path: `struct.get`/`struct.set`, no `$Object` boxing). The
forcing MUST be scoped to genuinely-dynamic `any`-typed plain-object receivers
and MUST NOT capture statically struct-typed class instances or
`resolveStructNameForExpr`-resolvable receivers. A WAT byte-diff of a
class-instance method hot path (and the inline-literal data path) is a required
guardrail. Floor-gate the standalone HW hard — a representation slip can
regress a broad swath at once.

## Acceptance criteria

1. `const o: any = {}; const d: any = {value:42}; Object.defineProperty(o,"x",d);
   o.x === 42` and `o.hasOwnProperty("x") === true` standalone.
2. The `built-ins/Object/defineProperty` ToPropertyDescriptor cluster
   (`15.2.3.6-3-*`, throw + hasOwnProperty=false cases) flips — re-measure the
   ~235.
3. Class-instance struct fast path UNCHANGED (WAT byte-diff; #1673 + class
   equivalence suites green).
4. No standalone HW regression.

## Notes

- #2371 is the native single-descriptor applier this unblocks (committed,
  0-flip-until-this). #1906 (plural) is done. The applier set is complete;
  only the receiver representation remains.
- Recommend an architect spec (functions, the exact body-scan predicate, the
  struct-vs-$Object decision boundary) before dev dispatch — this is `max`
  reasoning_effort and high blast radius.
