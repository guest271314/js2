---
id: 2901
title: "Standalone: %TypedArray%/view intrinsic constructor objects + getPrototypeOf chain"
status: in-progress
assignee: ttraenkler/sendev-typedview
created: 2026-06-30
priority: high
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2893, 2872, 2651, 2885, 2876]
umbrella: 2860
blocks: [2893]
---

# Standalone: %TypedArray%/view intrinsic constructor objects + getPrototypeOf chain

## Why this exists (root cause, depth-probed for #2893, 2026-06-30)

#2893 built the standalone reflective `%TypedArray%` accessor-getter bodies
(`length`/`byteLength`/`byteOffset`) and proved they work (0-import:
`gOPD(Uint8Array.prototype,"length").get.call(new Uint8Array(8))` → 8). But they
flip **zero** test262 rows, because **every** accessor test reaches the getter
through the `testTypedArray.js` harness (line 64):

```js
var TypedArray = Object.getPrototypeOf(Int8Array);   // → %TypedArray% intrinsic ctor
var TypedArrayPrototype = TypedArray.prototype;       // → %TypedArray%.prototype
var getter = Object.getOwnPropertyDescriptor(TypedArrayPrototype, "length").get;
```

…and **`Object.getPrototypeOf(Int8Array)` throws standalone**. Depth-probe root
cause (all on current main, `target:"standalone"`):

- Standalone models **prototypes only**. A bare view-constructor identifier
  (`Int8Array`, `Uint8Array`, …) compiles to `ref.null.extern` — there is **no
  constructor object** as a runtime value.
- `%TypedArray%` exists only as a `$NativeProto` **prototype** glue
  (`ensureTypedArrayIntrinsicNativeProtoGlue`), **not** as a constructor.
- `Object.getPrototypeOf(<non-class externref>)` falls through to a
  `drop`/`ref.null.extern` fallback when the host import is absent.

So the harness can't even obtain `TypedArray.prototype`; the entire
reflective-accessor corpus is blocked **upstream of #2893**.

This is broader than the accessors: standalone builtin **constructor-as-value**
is the shared substrate for `getPrototypeOf`, `instanceof`, and static methods on
the typed-array constructors (and a model for other builtins).

## What's needed

A standalone runtime representation of the typed-array constructors **as value
objects**, with the prototype chain wired so the harness path resolves:

1. Each concrete **view constructor** (`Int8Array`…`Float64Array`) materializes as
   a constructor object whose `.prototype` is the existing `<View>.prototype`
   glue and whose `[[Prototype]]` is the `%TypedArray%` intrinsic constructor.
2. A `%TypedArray%` **intrinsic constructor** object whose `.prototype` is the
   existing `%TypedArray%.prototype` glue.
3. `Object.getPrototypeOf(<view ctor>)` → the `%TypedArray%` intrinsic ctor;
   `(<that ctor>).prototype` → `%TypedArray%.prototype`.

This MUST NOT collide with the syntactic `new Int8Array(...)` construction path
(which is name-keyed, not identifier-as-value) and MUST be host-free standalone.

## Acceptance

- `Object.getPrototypeOf(Int8Array)` returns a non-null `%TypedArray%` intrinsic
  ctor object standalone; `.prototype` on it resolves to `%TypedArray%.prototype`.
- A real `testTypedArray.js`-harness-driven accessor test passes standalone
  (e.g. `TypedArray/prototype/length/this-has-no-typedarrayname-internal.js`),
  once #2893's getter bodies stack on top.
- `result.imports` empty for the getProtoOf/`.prototype` path.
- Full `merge_group` standalone report **NET-POSITIVE with ZERO offsetting
  regressions** — the `Int8Array`-as-value path is broad; this is the −601/−2469
  broad-builtin-identifier blast-radius class, validated against full CI, not a
  scoped sweep.

## Implementation Plan

_(Pending the constructor-as-value representation map; filled in below.)_

## Notes

Predecessor split out of #2893 after the depth-probe showed the accessor getters
are gated on constructor-as-value materialization, not on the getter bodies. The
#2893 PR-1 accessor commit (e90267950) stacks on top of this so the combined
change lands net-positive. Escalated + accepted by tech lead 2026-06-30.
