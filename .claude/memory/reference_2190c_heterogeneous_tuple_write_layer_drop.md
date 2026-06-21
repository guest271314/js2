---
name: reference_2190c_heterogeneous_tuple_write_layer_drop
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2190c / task #89 (PR #1779, sdev-arrayrep): standalone `const e: any[] =
[["a",7]]; e[0][1]` (and number-first `[[7,"ab"]]`) trapped on read-back.

CRITICAL: the task was MIS-FRAMED as a read-back-arm gap in
`boxVecElementToExternref` (like #88). It is NOT — it's a WRITE-LAYER bug in
`compileArrayLiteral` (src/codegen/literals.ts). The first-element heuristic
picks a HOMOGENEOUS inner vec from element 0:
- `["a",7]` → `$AnyString[]`; the number 7 can't store → `f64.const 7; drop;
  ref.null $AnyString; ref.as_non_null` (null slot).
- `[7,"ab"]` → `f64[]`; the string → `extern.convert_any; __unbox_number` = NaN.
The off-kind element is LOST at construction; the read just surfaces the null/NaN.

Fix = two mirror widenings in compileArrayLiteral, gated `ctx.nativeStrings`:
1. string-first: heuristic picked $AnyString/$NativeString but a non-string
   element exists → widen vec to externref (this IS the #2511 widening, which
   was NOT on upstream/main — PR #1776 unmerged — so it had to be re-added here).
2. number-first: in the `hasObjectElem` arm, also detect a native-string
   element, but ONLY when the literal's contextual element type is `any`.

KEY TS GOTCHA: an inner tuple `[7,"ab"]` of an `any[]` is contextually typed
`any` DIRECTLY (flags=1), NOT `Array<any>`. A top-level `const a: any[] =
[7,"ab"]` is contextually `Array<any>` (elem `any`). Accept BOTH:
`(ctxType.flags & Any) ? ctxType : getTypeArguments(ctxType)[0]`. This `any`-gate
is what keeps a genuine `(number|string)[]` union / `number[]` literal on its
fast path (preserves #1021/#786 + historical `[0,"last"]`).

OUT OF SCOPE (still broken, distinct): `(number|string)[]` union-typed
`[0,"last"]` traps on `(a[1] as string)` — a union-representation problem, not an
`any` context. Broken on main too.

Related: [[reference_2190a_string_subarray_readback_extern_get_idx]] (the #88 READ
arm in the same family), [[project_type_index_shift_and_deadelim]].
