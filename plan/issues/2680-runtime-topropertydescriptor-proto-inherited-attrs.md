---
id: 2680
title: "Runtime ToPropertyDescriptor reads a WasmGC-struct descriptor's attributes own-level only (drops prototype-inherited get/set/value/enumerable/configurable)"
status: ready
created: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen/runtime
es_edition: 5
language_feature: property-descriptors
goal: spec-completeness
related: [2668, 2580]
sprint: 66
---
# #2680 — ToPropertyDescriptor reads a struct descriptor's attributes own-level only

## Problem

The runtime `ToPropertyDescriptor` reader used by `Object.defineProperty`
(`__defineProperty_desc`, `src/runtime.ts`) and `Object.defineProperties`
resolves a **WasmGC-struct descriptor's** attribute slots
(`value` / `writable` / `enumerable` / `configurable` / `get` / `set`) by
consulting **only the descriptor object's OWN level** — its own struct fields +
own `_wasmStructProps` sidecar (`_getStructFieldNames` / own-sidecar in the
`getField` / `hasField` closures, `runtime.ts` ~8366-8399).

Per ES §10.1.6 → §10.1.7, `ToPropertyDescriptor` uses **`HasProperty` + `Get`**,
both of which are **prototype-chain-inclusive**. So a descriptor whose attribute
lives on a PROTOTYPE is silently dropped:

```js
var proto = {}; Object.defineProperty(proto, "enumerable", { value: true });
var child = Object.create(proto);
Object.defineProperty(obj, "property", child);   // enumerable read as ABSENT → false
```

```js
Array.prototype.enumerable = true;
Object.defineProperty(obj, "property", []);       // enumerable read as ABSENT → false
```

This is the **`built-ins/Object/defineProperty/15.2.3.6-3-23..45`** for-in
cluster (descriptor attributes inherited via prototype). Reading `child.enumerable`
or `"enumerable" in child` directly *also* returns absent/false — so the gap is
a broader **`Object.create(proto)` + sidecar-descriptor prototype-read**
limitation, not specific to defineProperty.

## Why it matters / what it blocks

- **#2668 Slice A** had to (a) REVERT a for-in `enumerable:false`-honoring filter
  (it wrongly hid these proto-enumerable properties as non-enumerable) and
  (b) NARROW the dynamic-descriptor route to literal-resolvable-only
  (`Math`/`Date`/`Object.create(proto)` descriptors are left on the prior path to
  avoid the drop). Both are blocked on this fix.
- **#2668 Slice B (accessors)**: accessor-redefine cases (`redefinition
  preserves unspecified halves`) and accessor descriptors whose `get`/`set` are
  proto-inherited need correct proto-walked attribute reads too.

## Acceptance criteria

- `getField` / `hasField` in `__defineProperty_desc` (and the matching reader in
  `__defineProperties`) walk the descriptor's **prototype chain** (bounded,
  cycle-safe) consulting each ancestor's own struct fields + sidecar +
  `_readOwnDescriptor`, so a proto-inherited descriptor attribute is read per
  spec `HasProperty`/`Get`.
- `15.2.3.6-3-23..45` (proto-inherited-attr for-in cluster) pass; no regression
  in the `15.2.3.6-3-*` data-descriptor family already fixed by #2668 Slice A.
- Once landed, re-introduce the #2668 for-in `enumerable:false` honoring filter
  (it is correct once the descriptor's enumerable is read accurately) and
  re-widen the Slice A dynamic-descriptor route to cover non-literal descriptors.

## Notes — feasibility: hard

Touches the runtime descriptor reader (broad object-model surface). The naive
own-level → proto-walk change risks the #1629 spurious-presence hazard (a
module-global `__sget_*` getter returns a value for EVERY field name on any
struct) — so the proto-walk MUST use the shape-precise `_getStructFieldNames` +
sidecar membership at each level, never a `__sget_*` try/catch probe. Validate
via the full `merge_group` floor — this is the path that auto-parked #2668
Slice A's first cut. Coordinate the standalone value-rep with #2580.

## Verify-first findings (sd-2668c, 2026-06-26) — VERDICT: BROAD (needs a proto-link representation, not a reader extension)

### The premise (proto chain is walkable) does NOT hold for wasmGC descriptors

Instrumented `__defineProperty_desc` on the real cluster. For the proto-inherited
pattern (`var proto = {…}; ConstructFun.prototype = proto; var child = new
ConstructFun(); Object.defineProperty(obj, "property", child)`), the descriptor
`child` is a **wasmGC struct with an EMPTY own sidecar**, and:

```
[dp76] objWasm=true descWasm=true descChain= wasm[[]]
```

`Object.getPrototypeOf(child)` returns **no link to `proto`** — the chain is just
`child → (null)`. There is **no `_wasmStructProto` sidecar** and no host
[[Prototype]] edge recording `ConstructFun.prototype = proto` on the instance
(confirmed: only `_prototypeMethodBridges` exists, which is method-name routing,
not a value-attribute proto link). So the runtime descriptor reader has **nothing
to walk** — the proto-carrying ancestor is unreachable at the
ToPropertyDescriptor boundary.

The acceptance criterion ("`getField`/`hasField` walk the descriptor's prototype
chain consulting each ancestor's own struct fields + sidecar") cannot be met
because the prototype chain is not represented at runtime for wasmGC instances.
This is the object-model substrate work coordinated with #2580 — **route to an
architect spec** (like #2688), not a bounded reader patch.

### Bounded sub-piece that WOULD be needed first (for the spec)

Codegen must record a **runtime-reachable prototype link** for wasmGC instances
whose constructor's `.prototype` was user-assigned (`ConstructFun.prototype =
proto`) and for `Object.create(proto)` when `proto` is a wasmGC struct — e.g. a
`_wasmStructProto` WeakMap (instance → proto struct), populated at
`__construct`/`__construct_closure` and `__object_create`. THEN `getField`/
`hasField` can walk it, consulting each ancestor's own fields + sidecar via
`_readOwnDescriptor`/`_getStructFieldNames` (the #1629-safe membership test, NOT
a `__sget_*` probe). The native fast-path (`!_isWasmStruct(obj) &&
!_isWasmStruct(desc)` → `Object.defineProperty(obj,key,desc)`) must also be gated
off when the descriptor has any wasmGC ancestor in that chain.

### Actual fail count this unblocks

- Of the **138** `built-ins/Object/defineProperty/15.2.3.6-3-*` family failures,
  only **~29 are genuinely proto-inherited-descriptor** cases (the #2680 target):
  `15.2.3.6-3-{31,32,76,77,78,80,81,82,85,129,133,134,135,138,208,209,210,212,
  213,214,216,217,238,239,240,242,243,244,246}`. The other ~109 are own-level /
  other sub-features (defineProperties batching, ToPropertyDescriptor edge cases)
  unrelated to proto-walk.
- The issue's cited cluster `15.2.3.6-3-23..45` is **mostly already passing** on
  current main (23,25,28,35,40,45 pass — #2668 Slice A covered them); the stale
  premise overstated the cluster.
- Indirect: unblocks re-introducing the #2668 Slice A for-in `enumerable:false`
  filter + re-widening the dynamic-descriptor route once the proto-link lands.

### Disposition

BROAD → escalated for an architect spec (next-sprint), same as #2688. The
~29-test ceiling + the substrate dependency (#2580) make a careful spec the right
path over a risky partial reader patch on the auto-park-prone descriptor surface.
