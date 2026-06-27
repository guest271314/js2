---
id: 2680
title: "Runtime ToPropertyDescriptor reads a WasmGC-struct descriptor's attributes own-level only (drops prototype-inherited get/set/value/enumerable/configurable)"
status: done
assignee: ttraenkler/dev2
completed: 2026-06-27
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
sprint: 67
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

## Implementation Plan (architect, verified on origin/main @ 5a92381, 2026-06-27)

### The verify-first finding (sd-2668c) was WRONG about "no proto link exists" — it MISSED #1712

The sd-2668c finding looked for `Object.getPrototypeOf(child)` returning `proto`
(a real JS `[[Prototype]]` edge) and, not finding one, concluded a whole new
`_wasmStructProto` representation must be built. **That conclusion is incorrect.**
A runtime-reachable instance→prototype link **already exists** in HOST mode
(`#1712`):

- `_fnctorInstanceCtor: WeakMap<object, object>` (`src/runtime.ts:71`) links each
  constructed fnctor instance struct → its **constructor closure struct**.
- It is populated by the `__register_fnctor_instance` host import
  (`runtime.ts:7669`), emitted in the fnctor ctor PROLOGUE
  (`src/codegen/expressions/new-super.ts:1267-1287`).
- `F.prototype = proto` stores `proto` in the **constructor closure's sidecar**
  under key `"prototype"` (host mode: `__extern_set_strict($ctorClosure,
  "prototype", proto)` — verified by tracing the repro).
- `_fnctorProtoLookup(obj, key)` (`runtime.ts:74`) already walks: `ctor =
  _fnctorInstanceCtor.get(obj)` → `proto = _sidecarGet(ctor, "prototype")` →
  walk `proto`'s chain.

So the link is real and reachable. There are **two actual gaps** (both verified by
instrumenting the cited-cluster pattern `var ConstructFun = function(){};
ConstructFun.prototype = proto; var child = new ConstructFun(); ...`):

**GAP A — the descriptor reader never consults the proto chain.** The
`getField`/`hasField` closures in `__defineProperty_desc` (`runtime.ts:8798-8826`)
and `__defineProperties` (`9064-9095`) read a wasmGC-struct descriptor's attribute
slots **own-level only** (sidecar + `__sget_<f>` + `_getStructFieldNames`). Per
ES §10.1.6.2 ToPropertyDescriptor → §7.3.12 HasProperty / §7.3.3 Get (both
proto-inclusive), a descriptor attribute on the descriptor's `[[Prototype]]` must
be read. They do not call `_fnctorProtoLookup` (or any proto walk).

**GAP B — even the existing proto walk is NOT wasmGC-aware.** `_fnctorProtoLookup`
(`74-89`) walks each ancestor with **native `Object.getOwnPropertyDescriptor(cur,
key)`** (line 83). When `proto` is itself a wasmGC struct (the common case: `var
proto = {}` is a wasmGC struct whose `configurable`/`enumerable`/`value`/`get`
attribute lives in proto's **sidecar**), `Object.getOwnPropertyDescriptor` on the
opaque struct returns `undefined` and the inherited attribute is dropped. This is
why even a DIRECT inherited read `child.configurable` returns `0`/false — verified.

### Verified buggy outputs (host mode, current main)

- `child.configurable` (direct inherited read, module-scope ctor) → `false`
  (expected `true`).
- `Object.defineProperty(obj,"property",child)` then
  `Object.getOwnPropertyDescriptor(obj,"property").configurable` → `false`
  (expected `true`).
- Trace confirms BOTH `__extern_set_strict($ctor,"prototype",<proto>)` AND
  `__register_fnctor_instance(child,$ctor)` fire (link populated), yet
  `_fnctorProtoLookup` returns `undefined` (it walks `proto` via native
  `Object.getOwnPropertyDescriptor`, which can't see the wasmGC-struct sidecar).

### Registration-scope precondition (already satisfied for the target cluster)

`__register_fnctor_instance` is emitted ONLY when the ctor closure is a **module
global** (`ctorGlobalIdx !== undefined`, `new-super.ts:1267-1287`). The cited
cluster uses top-level `var ConstructFun` (module global) → covered. A
**function-LOCAL** fnctor ctor is NOT registered → its instances have no link →
out of scope (a known, acceptable limitation for the ~29-test ceiling). Verified:
module-scope ctor emits the registration; a `const ConstructFun = function(){}`
inside a function does not. Do NOT widen the registration gate in this PR.

### Fix — two changes, both in `src/runtime.ts` (no new representation, no codegen change)

#### GAP B — make the proto walk wasmGC-aware (also fixes direct inherited reads)

**`_fnctorProtoLookup` (`runtime.ts:74-89`)**: thread `exports`
(`callbackState?.getExports()`) in (add a param; callers at `4148` and `4939`
already have `callbackState`/`exports`). At each `cur` in the walk: if
`_isWasmStruct(cur)`, read the own descriptor via the existing wasmGC-aware
`_readOwnDescriptor(cur, key, exports)` (`runtime.ts:4655` — reads sidecar +
descriptor table + `__sget_<key>` + class methods, the #1629-safe reader);
else use `Object.getOwnPropertyDescriptor(cur, key)` (plain JS ancestor). Advance
`cur` via: wasmGC struct → its recorded parent (the ctor-closure sidecar
`"prototype"` is already the first hop; deeper wasmGC chains via a recorded proto
link if/when present — for the cluster the chain is depth-1, so the first hop
suffices). Keep the existing 16-level guard + `Object.prototype` stop (cycle-safe).

#### GAP A — make the descriptor reader consult the proto chain

**`getField`/`hasField` in `__defineProperty_desc` (`runtime.ts:8798-8826`)** and
the matching pair in `__defineProperties` (`9064-9095`): after the own-level miss
(sidecar miss + `_getStructFieldNames` miss), walk the descriptor's prototype
chain via the #1712 link:

- `getField(o,f)`: own-level (unchanged) → on miss, `const d =
  _fnctorProtoLookup(o, f /*, exports*/)`; if `d` has a getter return
  `d.get.call(o)`, else return `d?.value`.
- `hasField(o,f)`: own-level (unchanged) → on miss, return
  `_fnctorProtoLookup(o, f) !== undefined`.

Both go through `_fnctorProtoLookup`, which (after GAP B) walks ancestor levels
with the **shape-precise** `_readOwnDescriptor` / `_getStructFieldNames`
membership — **NEVER** a `__sget_*` try/catch probe (the #1629 hazard: `__sget_*`
getters are module-global, one per field NAME, and do NOT trap on a struct lacking
the field, so a probe returns a spurious value for every ubiquitous descriptor name
`value`/`get`/`set`/`writable` → bogus data⇄accessor conflicts). This guarantee is
already met because `_readOwnDescriptor` and `_getStructFieldNames` are
shape-derived, not probe-derived.

#### Gate the native fast-path off when the descriptor has a wasmGC ancestor

`__defineProperty_desc` short-circuits `!_isWasmStruct(obj) && !_isWasmStruct(desc)
→ Object.defineProperty(obj,key,desc)` (`runtime.ts:8834`). A wasmGC descriptor is
already excluded (`_isWasmStruct(desc)` true → skips the native path). But a
**plain JS descriptor whose `[[Prototype]]` is a wasmGC struct** (e.g.
`Object.create(<wasmStruct>)`) would still take the native path and drop the
wasmGC-proto attribute. Extend the guard: also skip the native fast-path when the
descriptor's own proto chain contains any wasmGC struct (walk `Object.getProtoOf`
+ the #1712 link; bounded). For the cited cluster the descriptor is a wasmGC struct
already, so this is a no-regression hardening for the `Object.create(wasmStruct)`
neighbour — verify on the floor.

### Why this is small, not a substrate rebuild

The link + a 16-level cycle-safe walk already exist (#1712). The fix is: (1) make
the walk read wasmGC-struct levels via `_readOwnDescriptor` instead of native
`Object.getOwnPropertyDescriptor`, and (2) call that walk from the two descriptor
readers' own-level miss. No new WeakMap, no construct-site codegen, no #2580
substrate dependency for the host-mode cluster. (The standalone equivalent — where
descriptors are native `$Object` structs — rides on #2580 separately and is out of
scope here.)

### Edge cases
- Accessor descriptor whose `get`/`set` is proto-inherited (e.g. 15.2.3.6-3-31):
  `getField(o,"get")` walks to proto, `_readOwnDescriptor` returns the accessor
  pair; `_maybeWrapCallable` (the existing `wrap`, `8830`) makes it invocable.
- `child` overrides one half on its OWN level (own `set`, inherited `get`): own
  level wins (checked first); proto walk only fills genuine own-misses. ✓
- proto-inherited `enumerable:false` honoring (the #2668 Slice A re-introduction):
  once `getField(child,"enumerable")` reads the proto value accurately, the
  for-in filter can be re-enabled per the acceptance criteria.
- Function-local fnctor ctor descriptor → no link → own-level only (status quo,
  acceptable; not in the cluster).
- Cycle / deep chain: the existing `guard++ < 16` cap + `Object.prototype` stop
  prevent runaway.

### Validating tests (test262, the ~29 genuinely proto-inherited cases)
`built-ins/Object/defineProperty/15.2.3.6-3-{31,32,76,77,78,80,81,82,85,129,133,
134,135,138,208,209,210,212,213,214,216,217,238,239,240,242,243,244,246}.js`.
No regression in the own-level `15.2.3.6-3-*` data/accessor family already fixed by
#2668 Slice A (23,25,28,35,40,45,…). **Validate on the full `merge_group` floor** —
this is the descriptor surface that auto-parked #2668 Slice A's first cut.

### Coordination
- Independent of #2731 (different mechanism; #2731 is the delete-tombstone
  asymmetry, #2680 is the descriptor proto-walk). They can land in either order.
- Once landed: re-introduce the #2668 Slice A for-in `enumerable:false` filter and
  re-widen the Slice A dynamic-descriptor route (per this issue's acceptance).
