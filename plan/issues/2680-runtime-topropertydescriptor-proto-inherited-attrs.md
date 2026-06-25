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
