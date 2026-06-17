---
id: 2190
title: "standalone: array element indexing (arr as any)[i] returns null/0 through the externref boundary"
status: done
assignee: ttraenkler/sdev-proxy3
created: 2026-06-18
completed: 2026-06-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
goal: standalone-conformance
sprint: 63
depends_on: [2189]
---
# #2190 — standalone array element indexing through the externref boundary

## Problem

Sibling of #2189 (array `.length` through the externref boundary). A real array
literal lowers to a `__vec_<elemKind>` struct `(length i32, data (ref array))`.
When such a value crosses the **externref boundary** (assigned to an `any`
local, returned from an `any`-typed function, a Proxy trap's returned
key/args array), a **numeric** indexed read `arr[i]` routes through the native
`__extern_get_idx(externref, f64) -> externref` runtime helper
(`compileElementAccessBody`, `src/codegen/property-access.ts`, the
`objType.kind === "externref"` + `isNumericIndexExpression` arm — standalone
only).

That helper only recognises a `$ObjVec` (enumeration result) or an array-like
`$Object` (`{0:x, length:n}`). It does **NOT** recognise the concrete
`__vec_<elemKind>` struct, so a boxed array falls through to the `null` default.

Confirmed standalone repro (2026-06-18, vs upstream/main):

```ts
const a: any = [10, 20, 30]; a[1];   // => 0    (should be 20; null→f64 coerces to 0)
const a: any = ["x","y","z"]; a[2];  // => null (should be "z")
```

This is the **indexing** half of the same latent `$Array` introspection gap
#2189 fixed for `.length`. It blocks ANY element read after an externref
roundtrip — Proxy `ownKeys`/`apply` argsList element reads, generic array-like
consumers, `arguments`-style positional reads — so it should move a real chunk
of standalone test262.

## Root cause

`__extern_get_idx` has no arm that `ref.test`s the concrete `__vec_<elemKind>`
carrier types. Unlike `.length` (a single i32 at field 0, readable uniformly
through the `$__vec_base` supertype #2189 added), **element reads are
element-type-polymorphic**: each `__vec_<elemKind>` has a different `data`
array element type and the loaded element must be **boxed to externref**
differently per kind. A single supertype read cannot cover it.

Additionally, `__extern_get_idx` is registered eagerly inside
`ensureObjectRuntime` (lazy, first-use), but `ctx.vecTypeMap` is populated as
array literals of each element kind are compiled — which can be *after*
`ensureObjectRuntime` runs. So the set of vec kinds is not known at registration
time.

## Fix (design — confirmed against the existing `fillExternIsArray` pattern)

Use the **deferred body-fill** pattern already established by
`fillExternIsArray` (`src/codegen/object-runtime.ts`), which runs at
finalization in `src/codegen/index.ts` (~line 1672) AFTER all user functions and
late runtime helpers have registered their carrier types — so `ctx.vecTypeMap`
is complete.

1. **Reserve** `__extern_get_idx`'s typed-vec dispatch as a fill point (or, if
   simpler, keep the existing `$ObjVec`/`$Object` body and *append* a
   deferred-filled per-kind chain ahead of the `$ObjVec` test). Mirror
   `externIsArrayReserved` / `fillExternIsArray`.
2. In the fill, enumerate `ctx.vecTypeMap` carriers (reuse / factor out
   `collectStandaloneArrayCarrierTypeIdxs`, but here we need the **elemKind →
   typeIdx** mapping, not just the type set, to pick the right box op). For each
   `__vec_<elemKind>` (skip the non-array byte carriers `i32_byte`/`i8_byte`):
   - `ref.test $__vec_<k>` → if match: `ref.cast`, bounds-check `i` against
     `struct.get 0` (length) — return `null` when `i<0 || i>=len`, mirroring the
     existing `$ObjVec` arm — then `struct.get 1` (data) + `array.get` +
     **box the element to externref** per kind:
     - data `externref` / `ref_<anyStrTypeIdx>` (string-vec) → already a ref →
       `extern.convert_any` (or identity if already externref).
     - data `f64` → `__box_number`.
     - data `i32` → `f64.convert_i32_s` + `__box_number`.
3. Bounds/`$__vec_base` reuse: read the length via the `$__vec_base` supertype
   from #2189 for the bounds check (uniform), then the per-kind `ref.cast` only
   for the typed `array.get`.

Standalone-only (`objArrayLikeArms = ctx.standalone`); host mode's
`__extern_get_idx` JS import owns the path — do not register the arm in gc mode
(it would shift funcMap indices).

Files (expected):
- `src/codegen/object-runtime.ts` — reserve + `fillExternGetIdxVecArms` (new),
  factor an elemKind→typeIdx carrier enumerator.
- `src/codegen/index.ts` — call the new fill alongside `fillExternIsArray`
  (~line 1672).
- `src/codegen/context/types.ts` — a `externGetIdxVecReserved` flag if the
  reserve/fill split is used.

## Acceptance criteria

1. `const a: any = [10,20,30]; a[1] === 20` (number array). 
2. `const a: any = ["x","y","z"]; a[2] === "z"` (string array). 
3. `function g():any{return [1,2,3,4];} g()[3] === 4`. 
4. Out-of-bounds (`a[99]`) and negative (`a[-1]`) → `undefined`.
5. `$ObjVec`/array-like `$Object` indexing (existing arms) unchanged; no
   regression in typed-array indexing, for-of, spread, map/filter.
6. `tests/issue-2190.test.ts` green + canonical equivalence array suites green.

## Notes

- This is the second half of the foundational fix that unblocks Proxy
  `ownKeys`/`apply` standalone (#1355, #34/#36) — the trap's returned array can
  then be both *measured* (#2189) and *read* (#2190).
- The pre-existing typed `string[]` direct-index `["x","y"][0]` returning
  `undefined` (no externref roundtrip) is a separate string-array bug, NOT part
  of this fix.
