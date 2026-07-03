---
id: 2901
title: "Standalone: %TypedArray%/view intrinsic constructor objects + getPrototypeOf chain"
status: done
completed: 2026-06-30
assignee: ttraenkler/sendev-typedview
created: 2026-06-30
priority: high
task_type: feature
area: codegen
goal: standalone
sprint: 69
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

## Implementation Plan (as built)

The corpus reaches the §23.2.3 accessor descriptors through the test262
`testTypedArray.js` harness's `%TypedArray%` intrinsic, in TWO shapes:
1. full harness (`testWithTypedArrayConstructors` present):
   `var TypedArray = Object.getPrototypeOf(Int8Array); TypedArray.prototype`;
2. the **test262-runner injected shim** (the common accessor-test case,
   `test262-runner.ts ~1823`):
   `const TypedArray = Object.getPrototypeOf(Int8Array.prototype).constructor; TypedArray.prototype`.

Both then do `Object.getOwnPropertyDescriptor(TypedArrayPrototype, "<member>").get`
through intermediate vars. Three bounded, **syntactic / static-analysis** arms (no
runtime dispatch, no element-rep change), all standalone-gated and additive:

1. **`%TypedArray%` intrinsic ctor object** — `emitTypedArrayIntrinsicCtorObject`
   (`array-object-proto.ts`): a lazily-cached `$Object` singleton with a single
   `prototype` own-prop = the existing `%TypedArray%.prototype` glue (modelled on
   `emitBuiltinNamespaceObject`). Stable identity.
2. **`getPrototypeOf` arm** (`calls.ts`): `Object.getPrototypeOf(<view ctor>)` →
   the ctor object (full-harness shape).
3. **`.constructor` arm** (`property-access.ts`):
   `Object.getPrototypeOf(<view>.prototype).constructor` → the ctor object (the
   runner shim) — keeps the harness binding **non-null at runtime**.
4. **static gOPD/`.call` trace** (`calls.ts`, `tracesToTypedArrayIntrinsicProto`):
   recognises the *dynamic, variable-routed* `%TypedArray%.prototype` receiver so
   the #2885 gOPD synthesis + #2876 reflective `.call` fire through the harness's
   intermediate vars, not just the syntactic `<Ctor>.prototype` form.
5. `tryEnsureNativeProtoBrand("%TypedArray%")` → `ensureTypedArrayIntrinsicNativeProtoGlue`.

All arms keyed on **syntactic call shapes**, never identifier-as-value — so they
cannot collide with the name-keyed `new Int8Array()` construction path
(`new-super.ts`). Stacks the #2893 integer-view accessor getter bodies in the same
branch/PR.

## Result (standalone, verified)

Targeted before/after sweep (125 files: TypedArray accessor dirs + RegExp gOPD +
Object/getPrototypeOf + ArrayBuffer): **28 → 40 pass, ZERO regressions**, +12
fail→pass — `length`/`byteLength`/`byteOffset` × {`this-is-not-object`,
`invoked-as-func`, `length`, `prop-desc`} flip host-free (0 imports). RegExp
syntactic-gOPD path, Object.getPrototypeOf, ArrayBuffer all unchanged.

### Known out-of-scope residuals (follow-ups, NOT regressions)
- `name.js` — needs the getter closure's dynamic `.name` (`"get length"`) via
  `nativeClosureMeta` (function-metadata lever, #2896 family).
- `resizable-*` / `resized-out-of-bounds-*` — resizable ArrayBuffer support.
- `invoked-as-accessor.js` — getter invoked via plain `obj.length` accessor lookup.
- `this-has-no-typedarrayname-internal.js` assert #3: `get.call(new ArrayBuffer(8))`
  returns `8` instead of throwing — the value comes from a typed-receiver `.call`
  shortcut (NOT the #2893 getter, whose `ref.test` cascade correctly excludes
  `$__vec_i32_byte`). Pre-existing: before this work `gOPD(...).get` was
  `undefined`, so this test failed anyway — **no regression**. Track separately.
- `buffer` accessor (PR-3) + float-view brand split (#2893 PR-2) still pending.

## Notes

Predecessor split out of #2893 after the depth-probe showed the accessor getters
are gated on constructor-as-value materialization, not on the getter bodies. The
#2893 PR-1 accessor commit (e90267950) stacks on top of this so the combined
change lands net-positive. Escalated + accepted by tech lead 2026-06-30.
