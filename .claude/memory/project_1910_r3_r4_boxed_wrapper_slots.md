---
name: project_1910_r3_r4_boxed_wrapper_slots
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#1910 R3 + R4 standalone boxed-wrapper-slot fixes (PRs #1768, #1771, both off upstream/main, 2026-06-19).

**R3 (Boolean wrapper ToNumber/valueOf, PR #1768):** arch spec said "__new_Boolean boxes f64 not bool" — STALE. On current main `__new_Boolean` (object-runtime.ts ~L1090) already boxes a real `__box_boolean_struct` in the wrapper's FLAG_INTERNAL slot, and `__to_primitive` recovers it. The REAL bug was downstream: the standalone-native `__unbox_number` body (index.ts, `addUnionImportsAsNativeFuncs`) had no boxed-boolean arm → boxed bool fell to the opaque-ref NaN fallback. So `Number(new Boolean(true))` = NaN. Fix: + `$box_boolean_struct` arm (`f64.convert_i32_s`). Also `Boolean.prototype.valueOf` was excluded from the standalone wrapper-accessor block in calls.ts (~L6943) → added `__to_primitive` slot read + `__unbox_boolean`→i32.

**R4 (String wrapper .length / w[i], PR #1771):** `new String("ab")` is a `$Object` with `[[StringData]]` in the FLAG_INTERNAL slot. `.length` (primitive-string arm gates on isStringType, NOT isStringWrapperType) and integer-index `w[i]` hit the generic `$Object` path → null-deref. Fix in property-access.ts (standalone+nativeStrings): both route via `__to_primitive(recv,"string")` slot read; `.length`→coerce $AnyString→struct.get len; `w[i]`→`__str_flatten`→reuse native `__str_charAt(flat,i)`. SCOPED to .length + integer-index read; String-exotic own-property ENUMERATION (Object.keys/in/for-in over indices) is a separate larger tail. `(s[0] as any).method()` any-cast dispatch is also separate (indexed read itself is correct).

**Lesson:** MEASURE-FIRST caught both substrate moves — always reproduce-still-failing on current main before building from an older arch spec; the slot rep and helper bodies shift between sessions. See [[feedback_verify_fix_in_git_not_narrative]], [[reference_no_rebuild_helper_body_at_finalize]].

**#1737 (#2377 Error/Map/Set proto value-read):** verified SUPERSEDED — commit 3fd316b72 already on main via #1169l/PR#100 wave; 9/9 test pass on main; PR #1737 DIRTY because it conflicts with the landed copy of itself. Recommended close, 0 flips.
