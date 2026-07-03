---
id: 2893
title: "Standalone: distinct %TypedArray% view brand (unblocks #2872 reflective getter/method bodies)"
status: done
completed: 2026-06-30
assignee: ttraenkler/sendev-typedview
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: 69
horizon: l
related: [2872, 2375, 2593, 2651, 2885, 2876, 2901]
umbrella: 2860
blocks: [2872]
depends_on: 2901
---

> **PR-1 delivered (2026-06-30, stacked on #2901 in one PR).** The integer-view
> §23.2.3 accessor getter bodies (`length`/`byteLength`/`byteOffset`) are wired and
> verified host-free; the harness reachability they were gated on is provided by
> the #2901 `%TypedArray%`-intrinsic constructor + getProtoOf/gOPD chain (the two
> land together). Combined result: TypedArray accessor corpus 28→40 standalone, 0
> regressions. PR-2 (float-view brand split) and PR-3 (`buffer` + per-name brand)
> remain open as follow-ups.

# Standalone: distinct %TypedArray% view brand

## Why this exists (root cause, traced 2026-06-30)

The #2885 gOPD builtin-proto accessor synthesis + #2876 reflective `.call`
recovery are the standalone reflection **machinery** (both merged). They light up
the reflective surfaces (`gOPD(Proto, m).get`, `desc.get.call(R)`, plain reads)
**for free** for any brand whose getter/method `emitMemberBody` produces a real
body — proven for RegExp (#2876: 28→47 accessor passes).

For `%TypedArray%`/view (#2872), the glue (`makeTypedArrayGlue`,
`array-object-proto.ts:696`) advertises the four accessor getters
(`buffer`/`byteLength`/`byteOffset`/`length`) but its `emitMemberBody` is
`emitProtoMemberBodyRefusal` for **every** member — so the closure factory returns
null and both the gOPD synthesis and the reflective `.call` fall through (verified:
`gOPD(Uint8Array.prototype, "byteLength")` still → `undefined`). The clusters'
remaining bulk is the native member **bodies**, not glue.

**The blocker for those bodies is a representation gap, not a coding slice.** A
reflective getter receives `this` as an opaque `externref`, so its body must
brand-check "is this a `%TypedArray%` view?" at runtime (RequireInternalSlot
[[TypedArrayName]], §23.2.3.x step 2 — **throw TypeError otherwise**). But in the
standalone WasmGC representation a TypedArray view, a plain `number[]`, and (per
storage key) an ArrayBuffer **share the same `$Vec` struct type with no
distinguishing brand/tag**. The codebase states this directly:

> `index.ts` (~#1700): "The Wasm signature for `Uint8Array` and `number[]` is
> identical (`(ref null $Vec[f64])`)."

So an opaque `$Vec[f64]` could be a `Float64Array`, a `Float32Array`, **or** a
plain `number[]`. The `length`/`byteLength`/… getters cannot satisfy the
spec's throw-for-non-view requirement — they can't tell a view from an array.
`#2375` already cautions against re-emitting a body that touches the view's vec
state off the proto; this is the underlying reason.

Even `length` (the most _uniform_ getter — element count is `$Vec` field 0
regardless of element width) is gated on this: the field read is trivial, the
**brand check is the wall**.

## What's actually needed

A **distinct runtime brand for TypedArray views** so an opaque `externref` can be
classified as "a view of constructor X" (or "not a view") at runtime — without it,
none of the §23.2.3 accessor getters (nor the per-method `RequireInternalSlot`
checks) can be implemented reflectively. Options to weigh (coordinate with #2593's
packed-storage migration and #2375):

1. **Tag field on the view `$Vec`** — add a small brand/elem-kind tag field to the
   view struct (or a view-wrapper struct around the backing vec). Lets a runtime
   `__is_typed_array_view(externref) -> i32` + `__view_elem_kind` drive the brand
   check + per-constructor `BYTES_PER_ELEMENT`. Touches every TA construction +
   element read/write site → must pair with #2593.
2. **Distinct view struct subtype per element kind** — separate nominal types for
   `Int8Array`…`Float64Array` views (subtypes of the backing vec), so `ref.test`
   against the view-type set classifies it and disjoint from plain-array vec types.
   Cleaner brand check; larger type-graph + construction churn.

Either is a **representation change** spanning #2593/#2375, not a getter-body PR.

## Once landed (the payoff)

With a view brand, the §23.2.3 getter bodies become straightforward (brand-check →
read field / compute byteLength = count × BYTES_PER_ELEMENT → throw on non-view),
and the #2885 + #2876 machinery then flips the #2872 reflective-accessor subset
(`this-val-*`, `prop-desc` accessor reads, `desc.get.call(view)`) **for free** —
mirroring the RegExp result. The `verifyProperty`/`*.name` subset additionally
needs lever-2 (dynamic `.name`/`.length` on the opaque closure via
`nativeClosureMeta` by funcref identity) + mutable property-descriptor semantics;
track those separately.

## Acceptance

- A runtime classifier distinguishes a `%TypedArray%` view from a plain array /
  ArrayBuffer for an opaque `externref` (standalone).
- The four §23.2.3 accessor getter bodies implemented on it (start with `length`
  to validate the recovery shape, then `byteLength`/`byteOffset`/`buffer`).
- `gOPD(<View>.prototype, "byteLength")` host-free (`result.imports` empty);
  `get.call(view)` returns the value, `get.call(<non-view>)` throws TypeError.
- Verify-first standalone; full `merge_group` + standalone high-water; 0 regressions.

## Implementation Plan (architect, 2026-06-30)

### Re-grounded against current main — the rep gap is SMALLER than the issue body claims

The issue body cites the stale `index.ts ~#1700` comment ("`Uint8Array` and
`number[]` share `(ref null $Vec[f64])`"). That comment **predates #2593/#2835**.
On current main (`origin/main`, verified) the standalone vec types are **already
disjoint** for the integer views:

| value | standalone vec struct (key) | width |
|---|---|---|
| `number[]` | `__vec_f64` | — |
| `Int8Array` / `Uint8Array` / `Uint8ClampedArray` | `__vec_i8_byte` | 1 |
| `Int16Array` / `Uint16Array` | `__vec_i16_byte` | 2 |
| `Int32Array` / `Uint32Array` | `__vec_i32_elem` | 4 |
| `ArrayBuffer` / `DataView` / `SharedArrayBuffer` byte buffer | `__vec_i32_byte` | (bytes) |
| `Float32Array` / `Float64Array` | `__vec_f64` ← **collides with `number[]`** | 4 / 8 |

(Source: `TYPED_ARRAY_PACKED_STORAGE` index.ts:205, gated `wasi||standalone`;
`typedArrayVecStorage` index.ts:223 is the single source of truth; `i32_byte`
byte-buffer split from `i32_elem` element storage at #2835; ArrayBuffer→i32_byte
at new-super.ts:4484.)

So `ref.test $__vec_i8_byte` on an opaque `externref` **already** proves "a byte
view, not a `number[]` and not an ArrayBuffer". The *only* residual
classification wall is the **float views vs `number[]`** (both `__vec_f64`) and
**Float32 vs Float64** (same struct). That collapses the "representation change"
to a single, bounded float-view split — everything else is getter-body wiring on
types that are already distinct.

### Approach — split into THREE PRs; only PR-2 is a rep change

**PR-1 (NO representation change) — integer-view §23.2.3 accessor getter bodies.**
Wire `makeTypedArrayGlue`'s `emitMemberBody` (array-object-proto.ts:696/703,
currently `emitProtoMemberBodyRefusal` for every member) to a new
`emitTypedArrayProtoMemberBody`, modelled **exactly** on
`emitRegExpProtoMemberBody` (regexp-standalone.ts:2460). For a getter:
1. **Proto-identity arm first** — `emitNativeProtoIdentityReturnUndefined(ctx,
   fctx, brand, 1, [ref.null.extern])` (native-proto.ts:499) so reading the
   getter with `this === %TypedArray%.prototype` returns `undefined` per
   §23.2.3.x (the proto-receiver case returns undefined), BEFORE the brand check.
2. **View brand-recovery prologue** — a new
   `recoverTypedArrayViewFromExternref(ctx, fctx, thisParamIdx=1)` returning
   `{ viewLocal, vecTypeIdx, width }` or `null`. Implement it by mirroring
   `recoverRegExpStructFromExternref` (regexp-standalone.ts:908) but over the
   **set** of view vec type idxs, reusing the cascade shape of
   `emitThisReceiverGuardConvert` (property-access.ts:6092): `any.convert_extern`
   `this` → for each view vec idx emit `ref.test`; on the first hit `ref.cast`
   and record the compile-time width; if **no** view type matches, emit a
   catchable TypeError (`emitBrandCheckTypeError`, the §23.2.3 RequireInternalSlot
   throw the `this-val-*` tests gate on). The candidate set in PR-1 is
   `{i8_byte, i16_byte, i32_elem}` (the registered keys whose `typedArrayVecStorage`
   maps to a TA view — derive from `ctx.vecTypeMap` filtered to those three keys,
   NOT all of `vecTypeMap`, so a plain `number[]`/ArrayBuffer is correctly
   rejected). Width is the compile-time constant per matched type (1/2/4).
3. **Member body off the recovered local:**
   - `length` → `struct.get fieldIdx 0` (the `$__vec_base` length prefix), box via `__box_number`.
   - `byteLength` → `length × width` (width is the compile-time constant), box.
   - `byteOffset` → `0` for a plain view; if the matched type is a
     `$__subview_<k>` (isSubviewTypeIdx, registry/types.ts:268) read field 2
     (`byteOffset`, in elements) × width. PR-1 may scope to plain views (offset
     0) and add the subview arm in the same PR if cheap.
   - `buffer` → defer to PR-3 (needs an ArrayBuffer materialization off the view;
     return the catchable refusal for `buffer` only in PR-1).

   Box every getter result to `externref` (the closure-call ABI + descriptor
   `.get` unify on externref — copy the box-by-kind tail of
   `emitRegExpProtoMemberBody`: i32→`__box_number` via f64, ref→`extern.convert_any`).

PR-1 flips the integer-view accessor subset (`this-val-*`, `prop-desc` accessor
reads, `desc.get.call(view)`) for `length`/`byteLength`/`byteOffset` **for free**
through the already-merged #2885 gOPD-synthesis + #2876 reflective-`.call`
machinery — mirroring the RegExp 28→47 result. **Zero rep change, so zero
element-path risk.**

**PR-2 (THE representation change) — float-view brand split.**
Give `Float32Array`/`Float64Array` their own standalone vec keys, distinct from
`number[]`'s `__vec_f64`:
- `TYPED_ARRAY_PACKED_STORAGE` (index.ts:205): add
  `Float32Array → { key: "f32_view", type: { kind: "f64" } }` and
  `Float64Array → { key: "f64_view", type: { kind: "f64" } }`. **Keep the
  element type `f64`** — do NOT switch Float32 to real `f32` storage here (that
  is f32 element-fidelity / `Math.fround`-on-write, a SEPARATE issue). The split
  is purely a distinct *struct identity* for the brand; the data array stays
  f64, so every existing float-element read/write keeps working unchanged once
  the key flows through `typedArrayVecStorage`.
- `reserveTypedArraySubviewTypes` (index.ts:7499): add
  `getOrRegisterSubviewType(ctx, "f32_view", {kind:"f64"})` and `"f64_view"` so
  `Float*Array.subarray()` is idx-stable (see hazards).
- Extend the PR-1 classifier candidate set to `{i8_byte, i16_byte, i32_elem,
  f32_view, f64_view}` with widths `{1,2,4,4,8}`. `number[]` stays `__vec_f64`
  → correctly rejected by the brand check.
- The marshalling boundary (`classifyTypedArrayType` index.ts:267, `wrapExports`)
  is **standalone-only affected** and standalone has no JS-host marshalling — but
  audit: host/gc mode keeps float views on `__vec_f64` (the packed map is gated
  `wasi||standalone`), so the host signature identity (`Uint8Array==number[]`) is
  untouched. No boundary work.

PR-2 unblocks the float-view accessor subset and fixes the latent
`Float32Array.byteLength` width bug (×4 vs the ×8 a shared f64 struct implied).

**PR-3 (follow-up, may be a separate issue) — `buffer` getter + per-view name
brand.** `buffer` needs an ArrayBuffer (`__vec_i32_byte`) materialized as a
window over the view's bytes (mirror the existing DataView `.buffer` recovery,
property-access.ts:3149). The `@@toStringTag` / `.constructor` subset and the
per-method `RequireInternalSlot` bodies additionally need the **signed/unsigned
within-width distinction** (Int8 vs Uint8 vs Uint8Clamped all share
`__vec_i8_byte`); that needs either distinct per-name view structs or a brand
*field*, which IS the larger rep change — keep it OUT of #2893. The issue's
acceptance (the four accessors, starting with `length`) is met by PR-1+PR-2.

### Index-stability / funcIdx hazards (these have bitten before)

- **Type-index stability (`project_type_index_shift_and_deadelim`,
  `reference_subview_type_idx_stability`):** the new `f32_view`/`f64_view` subview
  backing MUST be reserved in `reserveTypedArraySubviewTypes` at the deterministic
  up-front type-init point (index.ts:1146 call site), exactly like the existing
  `i16_byte`/`i32_elem` reservations — NEVER mint the float-view struct lazily
  mid-class-collection. The keystone bug #2593 hit (an inline
  `new Int32Array(4).byteLength` reading through a vec cast that never matched)
  was precisely a hoist-pass-vs-emit-pass type-index desync; the float views must
  follow the same reserve-late-once discipline. The classifier's `ref.test`
  cascade reads the type idxs from `ctx.vecTypeMap`/`ctx.subviewTypeMap` at
  body-emit time, so the reserved slots must already exist.
- **Late-import funcIdx shift (`reference_1461`/`reference_2193`):** the getter
  body boxes results via `__box_number`/`__box_boolean` — call `ensureLateImport`
  + `flushLateImportShifts(ctx, fctx)` (the exact pattern in `unboxArgToI32`,
  array-object-proto.ts:598) so a late import added inside the body cannot desync
  the in-progress closure's own funcIdx refs. Do NOT read typeof/box funcIdxs
  before `addUnionImports`/the late-import flush.
- **DCE renumber:** a reserved-but-unused `f32_view`/`f64_view` struct is pruned +
  renumbered cleanly by dead-elimination (it is unreferenced when the source has
  no float typed array), so the reservation is a true no-op for non-float-TA
  modules — gate-free, byte-identical.

### Edge cases

- `get.call(number[])` and `get.call(new ArrayBuffer(8))` MUST throw TypeError
  (RequireInternalSlot) — guaranteed because `number[]`=`__vec_f64` (not in the
  candidate set) and ArrayBuffer=`__vec_i32_byte` (not in the set).
- `get.call(%TypedArray%.prototype)` → `undefined` (proto-identity arm, before
  brand check).
- Empty view (`new Int32Array(0)`): `length`→0, `byteLength`→0 (no trap — the
  recovery casts the struct, reads field 0; the #2593 empty-view trap was the
  construction-vs-read key mismatch, already fixed).
- A subview (`a.subarray(1)`): `length` is the window length (field 0 of the
  `$__subview` struct, also a `$__vec_base` prefix), `byteOffset` = field 2 ×
  width. Add `$__subview_<k>` idxs to the candidate set if the subview-accessor
  tests are in scope.
- Signed/unsigned share a type → fine for these four accessors (identical width &
  semantics); only `@@toStringTag` cares (PR-3).

### Verify-first recipe (run BEFORE coding each PR)

```ts
// .tmp/probe-2893.mts — run the EXACT CI standalone path on current main
runTest262File(file, cat, undefined, "standalone")
```
1. Confirm the integer-view accessor tests FAIL today and the proto refusal is
   the cause: probe `Object.getOwnPropertyDescriptor(Uint8Array.prototype,
   "byteLength").get.call(new Uint8Array(8))` standalone → expect the
   "not yet implemented" refusal (the `emitProtoMemberBodyRefusal` text), proving
   the wall is the glue body, not the classifier.
2. PR-1 corpus: `test/built-ins/TypedArray/prototype/{length,byteLength,byteOffset}/`
   — `this-val-*.js`, `prop-desc.js`, `BigInt`-free view files. Expect fail→pass
   for the integer-view rows after PR-1.
3. PR-2 corpus: the same files' `Float32Array`/`Float64Array` rows + any
   `byteLength` width assertion on a Float32Array. Verify `number[]` length/...
   getters still THROW (no false-positive view classification).
4. Full `merge_group` + standalone high-water; 0 regression on the host lane
   (all new arms `ctx.standalone`/`noJsHost`-gated; host float views stay
   `__vec_f64`).

### Files

- `src/codegen/array-object-proto.ts` — `makeTypedArrayGlue` (696/703) →
  `emitTypedArrayProtoMemberBody` (new); reuse `emitNativeProtoIdentityReturnUndefined`.
- `src/codegen/typed-array-proto.ts` (new) or co-locate in array-object-proto.ts —
  `recoverTypedArrayViewFromExternref` + `emitTypedArrayProtoMemberBody`.
- `src/codegen/index.ts` — `TYPED_ARRAY_PACKED_STORAGE` (205, PR-2 float keys);
  `reserveTypedArraySubviewTypes` (7499, PR-2 float subview backing).
- `src/codegen/property-access.ts` — reuse `emitThisReceiverGuardConvert` (6092)
  cascade shape; `isSubviewTypeIdx`/`getSubviewArrTypeIdx` for the byteOffset arm.
- `src/codegen/regexp-standalone.ts` — read-only template
  (`recoverRegExpStructFromExternref` 908, `emitRegExpProtoMemberBody` 2460).

### Estimated cluster size + split verdict

#2872 totals ~294 `TypedArray/prototype/**` + ~39 `TypedArrayConstructors/**`.
**#2893 unblocks only the reflective-ACCESSOR subset** (length/byteLength/
byteOffset/buffer `this-val`/`prop-desc`/`desc.get.call` across the view family),
estimated **~50-90 rows** (mirrors RegExp's +19 but over 9 views × 4 getters).
The remaining ~200 rows are the per-METHOD reflective bodies (`fill`/`set`/
`copyWithin`/`slice`/`map`/`subarray`/`join`/`toLocaleString` …) + the
`@@toStringTag`/`*.name`/mutable-descriptor subset — those are NOT unblocked by
#2893 and belong to #2872 sub-tasks split per member family.

**SPLIT VERDICT: #2893 is bigger than one PR — split into PR-1 (integer-view
accessors, no rep change), PR-2 (float-view brand split, the rep change), PR-3
(`buffer` + per-name brand, likely a separate issue).** PR-1 alone is a focused,
low-risk slice that proves the recovery shape and banks the integer-view rows
without touching the element representation at all. Dispatch PR-1 immediately;
PR-2 only after PR-1's recovery shape is proven green.

## Notes

Filed after #2876 landed the reflective `.call` lever. The "#2872 just needs
per-cluster glue" framing was optimistic — the glue is gated on this representation
work. #2872 stays `blocked_on: 2893`.
