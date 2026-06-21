---
name: reference_2190a_string_subarray_readback_extern_get_idx
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2190a (PR #1777, sdev-arrayrep): standalone (`--target standalone`, NOT wasi)
`const e: any[] = [["a","b"]]; e[0][0]` trapped "dereferencing a null pointer".

Root cause: `boxVecElementToExternref` (src/codegen/object-runtime.ts ~L6506) —
the per-carrier element boxer that `fillExternGetIdxVecArms` calls to synthesize
`__extern_get_idx`'s typed-vec indexing arms — handled f64/i32/externref element
kinds but returned null (no arm) for a ref/ref_null GC-struct element. A
homogeneous-string sub-array lowers to a `$AnyString[]` inner vec, so it got no
arm → `__extern_get_idx(inner, i)` fell through to null → consuming
`ref.test $AnyString` failed → `struct.get $AnyString` null-deref. The first cut
of #2190 (PR #1673) explicitly DEFERRED GC-ref elements: a naive arm left a raw
`(ref null N)` on the helper's externref return = invalid Wasm (regressed ~90
standalone tests).

Fix: add a ref/ref_null arm scoped to STRING GC types only
(`ctx.anyStrTypeIdx`/`ctx.nativeStrTypeIdx`), box via `extern.convert_any` (the
universal GC-ref→externref conversion — genuine externref, not a raw ref). Non-
string GC-ref / boolean carriers stay skipped (validity hazard unchanged).

KEY GOTCHA: `ctx.standalone` is true ONLY for `target: "standalone"`, NOT
`target: "wasi"`. The wasi target still uses host imports (`__array_from_iter` +
`__extern_get`) so it shows a DIFFERENT (and unrelated) materializer; always
repro this family with `target: "standalone"` to hit the native
`__extern_get_idx` path. (This is the READ mirror of #2511's wasi/native-strings
heterogeneous-tuple WRITE fix — different target, different code path.)

NEXT RESIDUAL (#2190-family, banked for architect/follow-up): the standalone
HETEROGENEOUS `[["a", 7]]` `e[0][1]` still traps — its inner vec is
externref-element (not a string carrier), so a different read-back layer. Broken
on main too.

Related: [[reference_2379_new_array_n_boxed_any_elem_rep]],
[[reference_2372_dynamic_descriptor_struct_widening]].
