---
name: reference_1461_reduce_noinit_funcidx_desync
description: "#54/#1461 standalone reduce.call(o,cb) no-init invalid-Wasm root cause: number_toString native-func registration shifts indices after the forward hole-scan baked its __extern_has_idx call; flushLateImportShifts doesn't cover native-func regs"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#54 (#1461-family) standalone `Array.prototype.reduce.call(arraylike, cb)` **without** an initial value emits invalid Wasm (`if[0] expected type i32, found call of type externref`). With-init reduce/reduceRight are VALID + correct + host-free — only no-init breaks.

**Root cause (CORRECTED via instrumented build + wasm-dis):** the indices are STABLE at emit time — instrumented build showed `__extern_has_idx`=155 at BOTH capture (array-methods.ts ~line 730/740) AND scan-emit, and `__extern_get_idx`=152. So it is NOT a native-func-reg shift during this function. The break is at **module finalization**: `addUnionImports`/late-import reorder in index.ts shifts the FINAL binary layout such that the baked `call 155` resolves to `number_toString` in the emitted module, while the adjacent baked `call 152` (`__extern_get_idx`) survives. wasm-dis confirms: the no-init scan's `if` condition is `(call $number_toString ...)` → externref where `if` wants i32 → invalid Wasm. (My earlier "native-func reg shift" hypothesis was WRONG — pre-registering `number_toString` up-front was a no-op and didn't fix it.) This is genuinely an index.ts finalization-reorder bug, architect-scale, NOT localizable in array-methods.ts.

**PR-A LANDED (PR #1763, 2026-06-19):** un-refused reduce/reduceRight ONLY in the with-initial-value form (host-free, valid). Added `standaloneArrayLikeMethodRefused(methodName, callExpr)` (array-methods.ts ~line 524) — refuses reduce/reduceRight when `callExpr.arguments.length < 3` (no init). Measured base→patched on 260 reduce/reduceRight standalone test262 files: **pass 30→39 (+9), refuse-CE 140→40, 0 reg**. No-init stays a graceful CE (never invalid Wasm). Tests: tests/issue-1461-standalone-reduce-arraylike.test.ts.

**Remaining #54 follow-ons:**
- PR-B: fix the no-init finalization-shift (index.ts addUnionImports) → unlocks reduce/reduceRight no-init. Architect-scale.
- PR-C: native-eq search arm for indexOf/lastIndexOf/includes. They leak `__host_eq`/`__same_value_zero` (NOT in OBJECT_RUNTIME_HELPER_NAMES, object-runtime.ts:6765). `__any_strict_eq` (any-helpers.ts:1361) exists but operates on `$AnyValue` structs, while array-like elements are EXTERNREF-boxed primitives (`__box_number`/`__box_boolean`) — so PR-C needs the same boxed-primitive-externref recovery `__any_to_string` uses, applied to ===/SameValueZero. Self-contained but meaty runtime work.
- PR-D: sparse indexed result arm for map (filter's push-compaction doesn't fit map's index-addressed sparse semantics).

Measured 269 refuse-CE / 500 sampled files for the 6 refused methods. See [[reference_standalone_harvest_rootcausemap_mislabeled]].
