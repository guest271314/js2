---
id: 3488
title: "TypedArray compiler trap-gaps (.set / bit-precision / invoked-as-func) — unmasked by #3441, tighten the #3189 ratchet back"
status: ready
created: 2026-07-20
priority: medium
task_type: bug
area: test262-conformance
goal: test262-conformance
sprint: current
horizon: m
related: [3441, 3189, 3202, 3335]
---

# #3488 — TypedArray trap-gaps unmasked by #3441

## Summary

#3441 (worker-lane test262 sandbox parity — the TypedArray cluster + Atomics
were missing from `scripts/test262-worker.mjs`) let the TypedArray harness
corpus run PAST `__module_init` for the first time. That is a large net win
(+647 host, ~656 tests improve). But it also **unmasked pre-existing compiler
trap-gaps**: 28 TypedArray tests that used to die early at `__module_init`
(catchable "Cannot convert null to object") now execute their body and hit an
**uncatchable Wasm trap** (`null_deref` / `oob`), tripping the #3189
uncatchable-trap ratchet in the merge_group.

To land #3441 the ratchet was widened with a **temporary** per-category valve
(`TRAP_RATCHET_TOLERANCE` / `BASELINE_TRAP_GROWTH_ALLOW` repo variables, reset to
0 after #3430 landed). This issue tracks IMPLEMENTING the underlying gaps so the
ratchet floor tightens back — mirrors #3487 (illegal_cast fix-forward).

**These are NOT new miscompiles from #3441.** The traps are latent compiler gaps
in TypedArray semantics that were previously hidden behind the module-init
failure. #3441 only made them observable.

## Newly-trapping tests (from #3430 merge_group, run 29711072322)

### `null_deref` (+19; 166 → 185)

- `TypedArray/prototype/Symbol.toStringTag/BigInt/invoked-as-func.js`
- `TypedArray/prototype/Symbol.toStringTag/invoked-as-func.js`
- `TypedArray/prototype/buffer/invoked-as-func.js`
- `TypedArray/prototype/byteLength/invoked-as-func.js`
- `TypedArray/prototype/byteOffset/invoked-as-func.js`
- `TypedArray/prototype/length/invoked-as-func.js`
- `TypedArray/prototype/copyWithin/bit-precision.js`
- `TypedArray/prototype/set/bit-precision.js`
- `TypedArray/prototype/slice/bit-precision.js`
- `TypedArray/prototype/map/return-new-typedarray-conversion-operation-consistent-nan.js`
- (+9 more — pull the full list from the run's `test262-regressions-report` artifact)

Two sub-families:
1. **`*/invoked-as-func.js`** — calling a `%TypedArray%.prototype` accessor/method
   as a bare function (no TypedArray receiver) must throw a catchable `TypeError`
   ("called on a non-object / incompatible receiver"), but the codegen null-derefs
   the missing receiver instead. This is the reflective-accessor null-receiver
   guard gap (cf. #3441's sibling finding at `property-access.ts:1015`, routed to
   dev-3422 as #728).
2. **`*/bit-precision.js`** — bit-level round-trip checks that hit a null-deref in
   the element codec path.

### `oob` (+9; 48 → 57)

- `Promise/allSettled/resolve-element-function-length.js`
- `TypedArray/prototype/set/BigInt/boolean-tobigint.js`
- `TypedArray/prototype/set/BigInt/string-tobigint.js`
- `TypedArray/prototype/set/array-arg-offset-tointeger.js`
- `TypedArray/prototype/set/array-arg-primitive-toobject.js`
- `TypedArray/prototype/set/array-arg-set-values.js`
- `TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-same-type-sab.js`
- `TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-same-type.js`
- `TypedArray/prototype/with/index-validated-against-current-length.js`

Dominated by `TypedArray.prototype.set` argument-coercion paths (`ToInteger`
offset, `ToObject` primitive arg, cross-buffer copy) that index out of bounds
instead of doing the spec-ordered bounds check → catchable `RangeError`. Related
to the earlier `.set` bounds work in #3202 / #3335.

## Acceptance

- The listed tests no longer hit an uncatchable trap (they pass, or fail with a
  CATCHABLE error the harness can assert on).
- Reset `TRAP_RATCHET_TOLERANCE` / `BASELINE_TRAP_GROWTH_ALLOW` to 0 (already done
  post-#3430) and confirm the ratchet holds at the tightened floor (null_deref
  ≤ 166, oob ≤ 48, or the new post-fix counts).

## Notes

Filed as the #3441 fix-forward so the temporary trap-tolerance valve is provably
transitional, not a permanent floor raise. Suggest splitting into two slices:
(a) `invoked-as-func` reflective null-receiver TypeError (overlaps #728), and
(b) `TypedArray.prototype.set` OOB → catchable RangeError.
