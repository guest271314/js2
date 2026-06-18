---
id: 2357
title: "Standalone TypedArray subarray-aliasing — offset-windowing view representation"
status: ready
sprint: Backlog
created: 2026-06-18
priority: medium
feasibility: hard
reasoning_effort: max
task_type: architecture
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 2159
depends_on: []
---

# Standalone TypedArray subarray-aliasing — offset-windowing view representation

## Problem

`TypedArray.prototype.subarray(begin, end)` must return a **view that shares the
parent's backing store** (ECMA §23.2.3.30): mutating `sub[i]` writes through to
`parent[begin + i]`, and `parent[begin + i]` reads back `sub[i]`. In standalone
mode (`--target wasi` / native byte buffers) the current lowering returns a
**copy** — the alias is lost.

This was carved out of #2159 / #38 (the DataView-windowing slice, PR #1678)
because, unlike DataView, subarray-aliasing lands directly on the **hot `a[i]`
element-access path** for *every* typed array, so the representation choice has
broad blast radius and warrants a deliberate architect decision rather than an
inline dev fix.

## Current representation (the constraint)

- A typed array / vec is a struct `$__vec_<elem> { length: i32, data: (ref
  $__arr_<elem>) }`, subtyping the shared `$__vec_base { length: i32 }` (see
  `src/codegen/registry/types.ts` `getOrRegisterVecType` ~line 116 and
  `getOrRegisterVecBaseType` ~line 96). **There is no offset field.**
- `subarray`/`slice` lowering returns a value typed as the *same* vec struct:
  `inferStandaloneRegExpMatchArrayType`-adjacent helper in
  `src/codegen/index.ts:12570` returns `{ kind: "ref_null", typeIdx:
  receiverType.typeIdx }`; the actual element copy is in
  `src/codegen/array-methods.ts:2887` (`case "subarray"`).
- Element **read** lowering (`compileElementAccess`,
  `src/codegen/property-access.ts:4387`; vec arm ~line 4840) does:
  `struct.get $vec 1` (data) → compile index → `array.get`/`array.get_u`/`_s`
  (with an optional bounds-check elide, `isSafeBoundsEliminated`). It indexes the
  backing array **directly** — no base offset.
- Element **write** lowering (`compileElementAssignment`,
  `src/codegen/expressions/assignment.ts:2693`) mirrors the read: `struct.get
  $vec 1` → index → `array.set`. (Plus the packed-i8/i16 unpack from #2159
  Slice 1.)
- The DataView slice (PR #1678) added an **additive** `$__dv_window { buf,
  byteOffset, byteLength }` wrapper (`src/codegen/dataview-native.ts`
  `getOrRegisterDvWindowType` / `recoverDvBacking`) — but DataView accessors are
  a *separate* dispatch (`emitDataViewAccessor`), not the generic `a[i]` path, so
  that wrapper does **not** help subarray.

## The decision to make

Two viable representations, with a clear hot-path tradeoff:

### Option A — offset field on every vec

Add a third field `byteOffset: i32` (element offset, not byte) to
`$__vec_<elem>`; subarray sets `offset = parent.offset + begin`, `length = end -
begin`, shares `data`. Every element read/write adds `+ offset` to the index.

- **Pro:** one uniform shape; no per-access type discrimination; subarray and
  the parent are the same struct type, so existing type-flow is untouched.
- **Con:** taxes the hot `a[i]` path for **all** arrays (a `struct.get offset` +
  `i32.add` on every read and write), including the overwhelmingly common
  non-windowed case. Also perturbs the `$__vec_base` prefix invariant if `offset`
  is inserted before `data` (it must be appended after `data` to keep field 0 =
  length / field 1 = data, which #2190's `$__vec_base` length-through-externref
  fix and the DataView `struct.get fieldIdx:1` data reads both rely on — see
  `src/codegen/registry/types.ts` and the #2190 work). Appending offset as
  field 2 is safe for those invariants but still costs the per-access add.

### Option B — dedicated `$__subview` struct (recommended)

A separate `$__subview { base: (ref $__vec_base), byteOffset: i32, length: i32 }`
(or per-elem `base: (ref $__vec_<elem>)`) produced **only** by subarray/slice
windowing; plain arrays keep the bare two-field vec. The element path does a
runtime `ref.test $__subview` and routes windowed access through `base.data` +
`offset`; the non-windowed array falls through unchanged.

- **Pro:** **zero cost on the common non-windowed path** when the discrimination
  is structured to avoid a branch there (see below); contained blast radius
  (mirrors the `$__dv_window` pattern just shipped).
- **Con:** element access must discriminate view-vs-plain. Naively that's a
  `ref.test` branch on **every** `a[i]`, which is itself a hot-path tax — the
  crux this spec must resolve.

## Discriminating view-vs-plain WITHOUT a per-access hot-path branch

This is the heart of the #46 design. Candidate strategies (architect to choose +
justify):

1. **Static type-driven dispatch (preferred).** The result of `subarray`/`slice`
   is statically known at the call site (the helper at `index.ts:12570` already
   special-cases it). Give the *binding* that receives a subarray result a
   distinct wasm type (`$__subview`) in the local/type map, so
   `compileElementAccess` picks the windowed lowering **at compile time** by
   inspecting the receiver's resolved `ValType.typeIdx` — no runtime `ref.test`.
   Plain `Uint8Array` locals keep the bare-vec ValType and the bare-vec lowering.
   The runtime branch only appears where the static type is genuinely a union
   (e.g. a param typed `Uint8Array` that may receive either). Requires:
   - extending `inferLetConstInitializerWasmType` (index.ts ~12519) +
     `resolveWasmType` so a subarray-result binding resolves to `$__subview`;
   - a `compileElementAccess` arm keyed on `isSubviewStructType(receiverType)`
     that emits `base.data` + `offset + index`;
   - the matching write arm in `compileElementAssignment`.
2. **Subtype + single covariant lowering.** Make `$__subview` subtype the bare
   vec with `offset` defaulted to 0 on plain vecs, so one lowering (`struct.get
   offset` + add) serves both — collapses to Option A's per-access add but keeps
   the wrapper allocation cost off plain construction. Rejected unless (1) proves
   infeasible: it reintroduces the universal per-access add.
3. **Length-method / iterator funnel only.** Alias only through `.length`,
   iteration, and `.set`/`copyWithin`/`fill` (which already go through helper
   funcs), NOT raw `a[i]`. Cheap but **incorrect** for `sub[i] = v` raw writes,
   which test262 exercises directly — rejected as a partial.

## Acceptance criteria

- `let p = new Uint8Array(4); let s = p.subarray(1,3); s[0]=9; ` ⇒ `p[1]===9`
  (aliasing through raw `a[i]`), standalone.
- `p[2]` reads back `s[1]`; `s.length === 2`; `s.byteOffset` (if exposed) ===
  parent offset + begin.
- Negative / clamped `begin`/`end` per §23.2.3.30 (reuse the
  `emitNormalizeIndex` clamp already in `dataview-native.ts`).
- **No measurable regression on the non-windowed `a[i]` hot path** — the chosen
  discrimination must not add an instruction to plain-array element access (the
  Option-B-strategy-1 static dispatch achieves this; verify by diffing the WAT of
  a plain `for` loop over a `Uint8Array` before/after).
- Scoped standalone tests + an equivalence test; existing TypedArray suites green.

## Files / line refs (entry points)

- `src/codegen/registry/types.ts` — vec struct def (`getOrRegisterVecType` ~116,
  `getOrRegisterVecBaseType` ~96); add `$__subview` registration here (mirror the
  `$__dv_window` reg now in `dataview-native.ts`).
- `src/codegen/array-methods.ts:2887` (`case "subarray"`) + `src/codegen/index.ts:12570`
  (subarray/slice result-type inference) — build the `$__subview` sharing
  `parent.data`, set `offset`/`length`, instead of copying.
- `src/codegen/property-access.ts:4387` `compileElementAccess` (vec arm ~4840) —
  windowed-read arm.
- `src/codegen/expressions/assignment.ts:2693` `compileElementAssignment` —
  windowed-write arm.
- `src/codegen/index.ts` ~12519 `inferLetConstInitializerWasmType` /
  `resolveWasmType` — make a subarray-result binding resolve to `$__subview`
  (the static-dispatch enabler for strategy 1).
- Reference precedent: `src/codegen/dataview-native.ts` `$__dv_window`
  wrapper + `recoverDvBacking` (PR #1678) — same additive-wrapper pattern, but
  for the separate DataView accessor dispatch.

## Notes

Related: #2190 (array element indexing through the externref boundary — the
`$__vec_base` length-through-externref fix) constrains where new fields may be
inserted (length must stay field 0). The DataView windowing slice (PR #1678)
validated the additive-wrapper approach end-to-end; subarray differs only in that
its accessor IS the generic `a[i]` path, which is why the discrimination strategy
(above) is the load-bearing decision.
