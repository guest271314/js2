---
name: reference_2379_new_array_n_boxed_any_elem_rep
description: "#2379: standalone `new Array(N)` builds a boxed-any element array (type 1) while `[a,b,c]` builds a typed numeric element array (type 3) — sort/join stringify then ref.casts a boxed-any element to $AnyString = invalid Wasm; representation-scale, NOT a cast-site guard"
metadata:
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2379 verify-gate verdict (2026-06-19, standalone, WAT-probed current main):
a top-level `new Array(N).sort()`/`.join()` emits **invalid Wasm**
(`Invalid types for ref.cast: ref.as_non_null of (ref extern) has to be in
the same reference type hierarchy as (ref 6=$AnyString)` in `__module_init`).

**Root cause is representation, upstream of the cast site.** `new Array(N)`
constructs a vec whose backing element array is the **boxed-any/externref**
array (`array.new_default 1` = type 1), while an array LITERAL `[3,1,2]`
constructs a vec backed by the **typed numeric f64** element array
(`array.new_fixed 3 3` = type 3). So:
- literal: `array.get 3` → `number_toString` → `any.convert_extern` →
  `ref.cast (ref 6)` — cast operand IS the number_toString externref. VALID.
- `new Array(N)`: `array.get 1` (boxed-any element) → `ref.as_non_null` →
  `any.convert_extern` → `ref.cast null (ref null 6)` — cast operand is the
  boxed-any element itself (a boxed *number* extern), not a $AnyString. INVALID.

`elemType` for `new Array(N)` resolves to `externref`, so
`compileArrayDefaultToStringSort` (`src/codegen/array-methods.ts` ~4959) takes
the **non-numeric else arm** (`ref.as_non_null` on a raw boxed-any) instead of
the `isNumeric && numToStrIdx` arm, then the later `$AnyString` cast on a
boxed-number extern is illegal.

**Decision-gate lesson (the reusable bit):** when a `ref.cast` validates for
one construction of a value but not another, FIRST probe whether the element
TYPE diverges (WAT the element-array build: `array.new_fixed N` typed vs
`array.new_default 1` boxed-any) before adding any `ref.test`-guarded bail. If
the type is genuinely wrong (here it is), a cast-site guard PAPERS OVER a
mistyped element (silent mis-stringify / wrong result) — that's
representation-scale → escalate to architect, do NOT guard. The earlier
"`!receiverIsExternref` dispatch gate" hypothesis is dead: the `new Array(N)`
receiver is a typed vec `(ref null 2)`, not an externref, so that gate never
fires.

**Architect fix (one of):** (1) normalize `new Array(N)` element rep to the
typed-numeric vec when subsequent writes are numeric (unify at construction);
or (2) make typed-vec array-method stringify dispatch on the ACTUAL element
array type (boxed-any vs numeric) and route boxed-any through the runtime
any→string path. Banked in #2379 (status: blocked).
See [[feedback_verify_fix_in_git_not_narrative]], [[reference_vec_externref_key_not_uniform]].
