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

---

## Implementation Plan

> Author: architect (arch-es5), 2026-06-25. Grounded by reading the live
> mechanism on current main (the defineProperty path is untouched on
> `po-edition-gaps`, so the anchors hold for both). All file:line anchors below
> are against that tree — re-`grep` the function name before editing, sibling
> PRs shift line numbers (memory `feedback_reground_spec_against_current_main`).

### Root cause — the dual-path divergence

There are **two independent `[[DefineOwnProperty]]` implementations** in the
tree, and they disagree:

1. **Runtime path (high fidelity).** `_validatePropertyDescriptor`
   (`src/runtime.ts:1556`) is a near-complete ES §10.1.6.3
   `ValidateAndApplyPropertyDescriptor`: attribute defaulting on first define,
   redefine-preserves-omitted, all non-configurable illegal-change throws,
   `SameValue` value check, data↔accessor switch guard. It is reached by the
   JS-host imports `__defineProperty_desc` (`runtime.ts:8312`),
   `__defineProperty_value` (`runtime.ts:8418`), `__defineProperty_accessor`
   (`runtime.ts:8457`) and `__obj_define_from_desc` — all call
   `_validatePropertyDescriptor` (callers at `runtime.ts:8381, 8442, 8492, 8642,
   8673`) and store flags into the canonical sidecar tables `_wasmStructProps`
   (value, `runtime.ts:48`) + `_wasmPropDescs` (flags, `runtime.ts:583`) +
   `_wasmStructAccessors` (`runtime.ts:590`). The read-back path
   `_readOwnDescriptor` (`runtime.ts:4301`) reads those **same** tables, so the
   host-runtime round-trip is largely correct.

2. **Inline / struct fast-path (partial fidelity).** When the receiver resolves
   to a static WasmGC struct *and* the descriptor is an object literal with a
   `value`, `compileObjectDefineProperty` (`src/codegen/object-ops.ts:919`)
   takes the `useStruct` branch (`object-ops.ts:1308`, body at
   `object-ops.ts:1614`). This branch:
   - emits a raw `struct.set` for the value,
   - tracks attributes at **compile time** in `ctx.definedPropertyFlags`
     (Map keyed `varName:propName`, `object-ops.ts:1660-1717`) and
     `ctx.shapePropFlags` (`object-ops.ts:1726`),
   - runs a **hand-rolled, partial** validation inline
     (`object-ops.ts:1685-1714`) — and a second, separate runtime flag-check
     helper `emitDefinePropertyFlagCheck` (`object-ops.ts:709`) that stores
     flags into a **third, divergent** side-table keyed `__pf_<propName>`
     (`object-ops.ts:717`) via `__extern_get/set` — a table **nothing in
     `_readOwnDescriptor` consults**.

The failures are the cartesian product of the two paths disagreeing:

- **Attribute round-trip drops.** The struct fast-path's compile-time
  `definedPropertyFlags` and `__pf_` table are not the `_wasmPropDescs` table
  the read path reads — so `getOwnPropertyDescriptor` / `verifyProperty` see
  default `{writable,enumerable,configurable}=true` regardless of what was
  defined. This is the **single biggest** bucket (the `15.2.3.6-4-*`
  `verifyProperty` family, 735 tests).
- **Runtime behavior doesn't honor flags.** `writable:false` on a struct field
  does not block a later `obj.x = v` (the struct.set assignment path has no
  flag guard); `enumerable:false` is honored only when the read consults
  `_wasmStructPropertyIsEnumerable` (`runtime.ts:4389`) — but struct-fast-path
  fields never populate `_wasmPropDescs`, so for-in still lists them;
  `configurable:false` does not block `delete`. `verifyProperty` mutates the
  object to probe exactly these, so a dropped flag fails 2-3 assertions.
- **Partial inline validation.** `object-ops.ts:1685-1714` omits the
  `SameValue` value-equality exception, the accessor get/set-identity check, and
  only fires when both receiver var-name and prop-name are static literals
  (`varName`/`propName` both resolved). Any dynamic key or non-identifier
  receiver silently skips validation.
- **Array-exotic `length` unhandled.** `maybeEmitVecLengthGrowth`
  (`object-ops.ts:463`) handles *only* index-define→length-growth. Defining
  `"length"` itself (`RangeError` on a non-uint32 / fractional value; deleting
  out-of-range indices when shrinking; `writable:false` length blocking
  subsequent index adds) is **entirely missing** — `parseCanonicalArrayIndex`
  (`object-ops.ts:433`) explicitly rejects `"length"`.

### The fix strategy — converge on the runtime validator

**Do NOT extend the inline `__pf_`/`definedPropertyFlags` machinery.** It is a
parallel half-implementation. The strategy is to **route every define through
the already-correct `_validatePropertyDescriptor` + `_wasmPropDescs` sidecar**
and make the struct fast-path *also* publish to that sidecar, so reads,
for-in, writes, and delete all consult one source of truth. Concretely:

- Keep the `struct.set` value write (it is the zero-overhead storage for the
  common `{value}` case — the no-regression fast path), **but** after it, always
  emit a side-effecting call that records the *full descriptor flags* into
  `_wasmPropDescs` via the runtime — i.e. fold the struct path's flag handling
  into the **same** `__defineProperty_value(obj, key, val, flags)` sidecar write
  the externref path already uses (`emitExternDefinePropertyValue`,
  `object-ops.ts:2130`), rather than the divergent `__pf_` table. The struct
  path already has a TODO-shaped comment acknowledging this
  (`object-ops.ts:1305-1307`): *"emit an additional side-effect
  `__defineProperty_value` call … so attribute flags are propagated to the
  runtime sidecar (`_wasmPropDescs`) for later
  `Object.getOwnPropertyDescriptor` reads."* Verify whether that call is
  actually emitted today (read `object-ops.ts:1760-1960`) — if it is, the bug is
  that the *flags integer* passed is incomplete; if it isn't, that's the drop.
- Make **runtime behavior honor the sidecar flags**: the struct-field write
  path (member assignment `obj.x = v` lowering in
  `src/codegen/expressions/assignment.ts`) and `delete obj.x`
  (`src/codegen/typeof-delete.ts`) must consult `_wasmPropDescs` for
  writable/configurable when the field has a defineProperty'd descriptor. For
  the **standalone** target (no JS host) this needs a Wasm-native flag check;
  for **host** target the existing `__extern_set`/`__obj_delete` runtime entries
  already gate on the sidecar — confirm and wire the struct path to them.
- **Standalone parity (`ctx.standalone`)**: the `__defineProperty_*` and
  `__extern_*` host imports are refused under `--target standalone` (#1472
  Phase B — see the gate at `object-ops.ts:1224-1230`). The standalone path
  currently relies on the struct fast-path + `shapePropFlags` for flags. Slices
  must either (a) keep standalone on a Wasm-native flag-table struct field, or
  (b) explicitly scope each slice to **host mode first** and file a standalone
  follow-up. Recommend **(b)** per slice to keep slices small — the bulk of the
  788 fails run in host mode (the default test262 runner target). Coordinate
  the standalone value-rep with #2580 (the any-typed value-read substrate) and
  `project_standalone_any_string_value_read_substrate` — do **not** invent a new
  standalone descriptor representation here; defer standalone descriptor
  fidelity to a #2580-dependent follow-up.

### Representation — where per-property attributes live

| Store | Location | Holds | Read by |
|-------|----------|-------|---------|
| `_wasmPropDescs` | `runtime.ts:583` | `Map<key, flags:int>` WEC+ACCESSOR+DEFINED bits | `_readOwnDescriptor`, `_wasmStructPropertyIsEnumerable`, delete/write gates — **canonical** |
| `_wasmStructProps` | `runtime.ts:48` | dynamically-added / defineProperty'd **values** | read-back, has-check |
| `_wasmStructAccessors` | `runtime.ts:590` | `{get,set}` fns (incl. symbol keys) | accessor read-back |
| `ctx.definedPropertyFlags` | compile-time Map | `varName:propName → flags` | **inline path only — divergent, to be retired** |
| `ctx.shapePropFlags` | compile-time, per-structTypeIdx | WEC bits per user field | standalone GOPD fallback |
| `__pf_<prop>` extern table | `emitDefinePropertyFlagCheck` | boxed flags via `__extern_set` | **nothing canonical — to be retired** |

The flag bit layout is **already unified** between codegen and runtime:
`PROP_FLAG_*` (`object-ops.ts:646-650`: WRITABLE=1, ENUMERABLE=2,
CONFIGURABLE=4, DEFINED=8, ACCESSOR=16) ≡ `_SC_*` in `runtime.ts`. Reuse them;
do not introduce a new encoding.

**Target end-state representation:** `_wasmPropDescs` (host) is the single
source of truth for attributes; the struct field remains the value store for
the data-`{value}` fast path; `definedPropertyFlags` / `__pf_` are deleted once
their last reader is migrated. Standalone keeps `shapePropFlags` until #2580.

### Slice breakdown (each independently shippable)

Order matters: **Slice A first** — it is the largest bucket *and* establishes
the "publish-to-`_wasmPropDescs`" convergence the later slices build on.

#### Slice A — data-descriptor attribute round-trip + runtime honoring (host)
**~480-520 fails** (the `15.2.3.6-4-*` `verifyProperty` data-property family +
much of `defineProperties`). Highest ROI; do first.

- **Scope:** data descriptors (`value`/`writable`/`enumerable`/`configurable`),
  host mode. No accessors, no array-length.
- **Changes:**
  1. `src/codegen/object-ops.ts` — `compileObjectDefineProperty` `useStruct`
     branch (`~1614`): after the `struct.set`, ALWAYS emit the
     `__defineProperty_value(obj, key, val, flags)` sidecar call
     (`emitExternDefinePropertyValue`, `~2130`) with the **complete**
     `computeDescriptorFlags(...)`/`applyDescriptorFlags(...)` integer — so
     `_wasmPropDescs` is populated identically to the externref path. Verify the
     existing "additional side-effect" call at `~1760-1960` and fix the flags
     integer it passes (or add the call if absent).
  2. Retire the inline `emitDefinePropertyFlagCheck` (`~709`) / `__pf_` table
     for this path — let `_validatePropertyDescriptor` (already called by
     `__defineProperty_value`, `runtime.ts:8442`) be the sole validator. Remove
     the partial inline validation at `object-ops.ts:1685-1714` for non-frozen
     receivers (keep the `nonExtensibleVars` extensibility throw at `~1679`).
  3. **Runtime honoring of `writable:false`**: the `obj.x = v` struct-field
     assignment lowering (`src/codegen/expressions/assignment.ts` — grep
     `struct.set` member-assign) must, when `obj` has a `_wasmPropDescs` entry
     with `!WRITABLE`, route the write through the runtime
     `__extern_set` (which silently no-ops a non-writable data prop and throws in
     strict mode) instead of a bare `struct.set`. Simplest: when a field has
     *ever* been `defineProperty`'d on this receiver (`definedPropertyFlags`
     has the key, or unknown receiver), lower the assignment via the sidecar
     write rather than `struct.set`.
  4. `delete obj.x` honoring `configurable:false`: `src/codegen/typeof-delete.ts`
     — gate the struct-field delete on the sidecar's CONFIGURABLE bit (host
     `__obj_delete` already does — confirm the struct path reaches it).
- **Verify:** `15.2.3.6-4-100..140` (value/attribute round-trip),
  `15.2.3.6-4-292..360` (writable/enumerable/configurable behavior),
  `15.2.3.6-4-1.js` (non-extensible throw).

#### Slice B — accessor descriptors + data↔accessor switch (host)
**~140-180 fails** (the `15.2.3.6-4-*` accessor sub-family +
`defineProperties` accessor rows). Depends on Slice A's sidecar convergence.

- **Scope:** `get`/`set` descriptors (inline fn, fn-ref, `undefined`),
  redefinition preserving unspecified accessor halves, data↔accessor switch
  validation, host mode.
- **Changes:**
  1. `compileObjectDefineProperty` accessor branch (`~1355-1612`): ensure the
     accessor is mirrored into `_wasmStructAccessors` + `_wasmPropDescs` (the
     `emitExternDefinePropertyNoValue` → `__defineProperty_accessor` path,
     `runtime.ts:8457`, already does this — the bug is the static-struct branch
     `~1355` captures the getter into the compiled `${structName}_get_<prop>`
     fast path *instead of* the sidecar, so `getOwnPropertyDescriptor(o,k).get`
     identity and `verifyProperty` fail). Make the static-struct accessor branch
     **also** publish to the sidecar (one write reconciles every reader — the
     comment at `object-ops.ts:1331-1335` describes exactly this for the
     `any`-receiver case; extend it to the static-struct case for GOPD identity).
  2. data↔accessor switch validation is already in `_validatePropertyDescriptor`
     (`runtime.ts:1616-1632`) — once the accessor publishes through
     `__defineProperty_accessor`, the switch guards fire for free. Remove the
     partial inline data↔accessor throw (`object-ops.ts:1707-1712`).
- **Verify:** `15.2.3.6-4-209.js` (accessor update-all), the
  `get`/`set`-identity redefine rows, `defineProperty` accessor `verifyProperty`
  rows.

#### Slice C — Array-exotic `[[DefineOwnProperty]]` for `length` + index (host)
**~60-90 fails** (`defineProperty` array rows + a slice of `Array` length
tests). Independent of A/B (touches the vec path), can land in parallel.

- **Scope:** `Object.defineProperty(arr, "length", desc)` and the non-writable
  length / index-add interaction.
- **Changes:**
  1. `src/codegen/object-ops.ts` — add a `maybeEmitVecLengthDefine` sibling to
     `maybeEmitVecLengthGrowth` (`~463`): when `propArg === "length"` on a vec
     receiver, implement ES §10.4.2.1 `ArraySetLength`:
     - `ToUint32(value) !== ToNumber(value)` → **RangeError** (throw via
       `emitThrowRangeError` — add if missing, mirror `emitThrowTypeError`);
     - new length < current → delete (zero/tombstone) indices in
       `[newLen, oldLen)`; if any is non-configurable, throw TypeError and stop
       at that index (set length to that index + 1);
     - `writable:false` in the length descriptor → record a "frozen length" flag
       in the sidecar so subsequent index-defines beyond length throw.
  2. `maybeEmitVecLengthGrowth` (`~463`): before bumping, consult the
     frozen-length flag and throw TypeError if the index ≥ frozen length.
  3. `parseCanonicalArrayIndex` (`~433`) stays as-is (correctly rejects
     `"length"`); the new `"length"` handler is a separate branch.
- **Verify:** `defineProperty/redefine-length-with-various-values-and-configurable-true.js`,
  array index-define rows in `15.2.3.6-4-*` (e.g. `15.2.3.6-4-209.js` array
  receiver), `Array/length/*` define cases.

#### Slice D (optional cleanup, post A/B) — retire divergent tables
**0 direct fails** (regression-guard only). After A+B land and all readers
consume `_wasmPropDescs`, delete `emitDefinePropertyFlagCheck`, the `__pf_`
extern table, and `ctx.definedPropertyFlags` (keep `shapePropFlags` for
standalone). Pure simplification — ship only once A+B are green to avoid
churn during the migration.

### Edge cases (apply across slices)

- **First-define defaulting:** omitted attributes default to `false`/`undefined`
  — already correct in `_validatePropertyDescriptor` (`runtime.ts:1581-1599`).
  Ensure the struct fast-path computes the same via `computeDescriptorFlags`
  (`object-ops.ts:657`), **not** `PROP_FLAGS_DEFAULT_DATA` (which defaults all
  true — correct only for *plain assignment* `obj.x = 1`, **wrong** for
  `defineProperty`).
- **Redefine preserves omitted attributes** (`{value:5}` on an existing prop
  keeps its w/e/c) — runtime `applyFlag` (`runtime.ts:1581`) handles it; the
  struct path's `applyDescriptorFlags` (`object-ops.ts:671`) must pass the
  *current* flags, not defaults — verify the `currentFlags` resolution at
  `object-ops.ts:1662-1664`.
- **Non-configurable illegal changes** all throw TypeError: configurable
  false→true, enumerable flip, data↔accessor switch, writable false→true,
  non-`SameValue` value on non-writable. All in `_validatePropertyDescriptor`
  (`runtime.ts:1606-1646`). Slices A/B just need to *reach* it.
- **`SameValue` exception** (`runtime.ts:1642`, `Object.is`): a non-writable
  non-configurable data prop may be "redefined" with the *same* value (incl.
  `+0`/`-0`, `NaN`). Do not regress — the inline path lacks this (a reason to
  retire it).
- **Non-extensible receiver** adding a *new* prop → TypeError; redefining an
  *existing* field is allowed. Inline check at `object-ops.ts:1679` is
  receiver-var-name-gated; the runtime `__defineProperty_value` extensibility
  check (via `__ne`, `object-ops.ts:876-896` + runtime) is the general one.
- **Descriptor-field read order / read-once** (§ToPropertyDescriptor): the
  failing tests in this cluster are dominated by `verifyProperty` /
  `assert.throws`, not side-effect-ordering probes — **defer** strict
  read-order to a follow-up; it is a small sub-bucket. Note it in the slice-A
  PR as a known gap.
- **`defineProperties` batching:** `compileObjectDefineProperties`
  (`object-ops.ts:2628`) iterates descriptor entries; once each entry routes
  through the converged single-property path (A/B), batching is correct. The
  spec requires **all** descriptors validated against the live object in order;
  the dynamic fallback `__defineProperties` (`object-ops.ts:3260`,
  `runtime.ts`) already does this — ensure the inline-literal batching loop
  (`~2660-2703`) delegates per-entry to the same converged path rather than the
  old inline flag handling.
- **`ToPropertyKey` on the key**: numeric keys (`defineProperty(o, 0, …)`) box
  as number-externref and must be ToString'd — handled by #2042 PR-A
  (`object-ops.ts:2098`). No new work, just don't regress.

### Risks / coordination

- **File conflict surface:** `src/codegen/object-ops.ts` is the hot file; A, B,
  C all touch it. Land **A first**, then B and C rebased on it. C is the most
  isolated (vec path) and can go in parallel with B if devs coordinate the
  `object-ops.ts` import block.
- **`assignment.ts` / `typeof-delete.ts`** (Slice A steps 3-4) are shared with
  many other features — scope the flag-gate narrowly (only when the receiver has
  a defineProperty'd descriptor) to avoid regressing the plain-assignment fast
  path.
- **Standalone (`ctx.standalone`)**: every slice is **host-mode-first**.
  Standalone descriptor fidelity is gated on #2580's value-rep substrate — file
  a standalone follow-up per slice, do not block host-mode landing on it.
- **#2580 (any-typed value-read substrate)** and #2585/#2040 (tag-5 classifier)
  overlap the standalone struct-value read; keep this issue's standalone work
  out of scope to avoid colliding with that in-flight substrate work.
