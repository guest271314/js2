---
id: 3165
title: "Standalone: arguments object stored into any[] loses indexed elements on readback (length survives, r0[0] → 0) — ~186 tests"
status: done
sprint: 71
created: 2026-07-12
updated: 2026-07-13
completed: 2026-07-12
assignee: sendev-3164
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, standalone
language_feature: arguments-object, dynamic-properties
goal: standalone-mode
related: [3053, 3037, 2580, 1511, 3015]
# (#3131) LOC allowance: the fix replaces the emitElemBoxToExternref stub with
# the per-element-kind boxing arms inside the same subsystem module (+20 net).
loc-budget-allow:
  - src/codegen/array-methods.ts
origin: "2026-07-12 architect standalone audit: the TypedArray/Array `predicate-call-parameters` family fails with 'Cannot access property on null or undefined' inside the harness region; minimal repro isolated the arguments-capture readback."
---

# #3165 — arguments-object indexed readback through `any` drops elements

## Problem

Test262 idiom (used by ~252 tests; **186 fail in the standalone lane**,
mostly `built-ins/TypedArray/prototype/*/predicate-call-parameters.js` and
`Array.prototype` callbackfn-arguments tests):

```js
var results = [];
sample.findIndex(function() { results.push(arguments); });
var result = results[0];
assert.sameValue(result[0], 39);   // FAILS
```

**Verified live** (2026-07-12, upstream/main @ adc65cfc65, `--target standalone`):

| Probe | Result |
| --- | --- |
| `results.push([v, i])`; `results[0][0]` (plain array control) | 39 ✓ |
| `function g() { return arguments[0]; }` (direct read control) | 39 ✓ |
| `results.push(arguments)`; `results[0].length` | 3 ✓ |
| `results.push(arguments)`; `results[0][0]` | **0 ✗ (expect 39)** |

So the arguments carrier ROUND-TRIPS through the `any[]` (`.length` reads
correctly), but the **dynamic indexed-element read** on the read-back `any`
value returns the missing-value default. In the real test262 shape (harness
`testWithTypedArrayConstructors` wrapper) the same gap surfaces as
`TypeError: Cannot access property on null or undefined` at the
`result[0]` line.

## Implementation Plan (architect)

### Root cause hypothesis (first dev step: confirm via WAT)

`arguments` is materialized as an **externref-element vec**
(`src/codegen/closures.ts:2789–2800`: `getOrRegisterVecType(ctx, "externref", …)`
+ `emitArgumentsVecBody`, #779e/#1511). When that vec ref flows into an
`any[]` slot it is boxed/erased to the dynamic carrier. On readback:

- the dynamic **length** arm recognizes the vec carrier (works), but
- the dynamic **indexed-read** arm does not have a case for the
  externref-element vec (or tests only the f64-element vec type), so it falls
  through to the missing-property default (0 / null depending on context).

This is the same carrier-dispatch family as memory note
`reference_vec_externref_key_not_uniform` and the #3053 unified-reader work.

### Changes

**1. Diagnose (bounded, 30 min):** compile the minimal repro with `emitWat`
and find the indexed-read dispatch used for `r0[0]` where `r0: any`. Expected
location: the dynamic element/member read helper in
`src/codegen/property-access.ts` (any-receiver indexed read) or the reader
emitted for `any[number]` in `src/codegen/expressions.ts`. Identify the chain
of `ref.test` arms — confirm the externref-elem vec type
(`getOrRegisterVecType(ctx, "externref", …)`'s typeIdx) is absent.

**2. Fix:** add a `ref.test <vec_externref>` arm to that dispatch, ahead of
the default:

```wasm
;; receiver (anyref, after any.convert_extern)
ref.test $vec_externref
if
  ref.cast $vec_externref
  ;; bounds-check idx against length field, then array.get $arr_externref
  ;; result is externref — matches the read's any-result convention
end
```

Follow the existing f64-vec arm in the same dispatch for the bounds/`length`
field layout (vec = struct{arr, length} — see `getArrTypeIdxFromVec` usage in
closures.ts:2792). Out-of-bounds → undefined (not trap), matching the
dynamic-read convention.

**3. Coordinate with #3053:** the unified `__dyn_member_get` substrate
(in-progress, opus) will eventually own this dispatch. Land this as an arm in
the CURRENT reader now (it is a small additive case), and note in #3053's
issue file that the arguments/externref-vec carrier arm must carry over.
Do NOT block on #3053.

### Edge cases

- `arguments.length` already works — do not disturb the length arm.
- `for (const a of result)` — iteration over the read-back carrier: verify,
  but out of scope if broken (separate iterator-protocol arm).
- Elements that are themselves boxed numbers (tag-5) — the vec stores
  externref elements; the read returns them as-is, downstream `sameValue`
  handles unboxing (verify with `result[2] === sample` object-identity case
  from the test — this exercises #3037 territory; if identity fails, the
  numeric asserts still flip the bulk of the tests).

### Validation

- Minimal repro above must return 39 (and `result[1]` → 0, `result.length` → 3).
- Scoped test262: `test/built-ins/TypedArray/prototype/findIndex/predicate-call-parameters.js`
  and 3–4 siblings (`every`, `filter`, `forEach`, `map`) via
  `runTest262File(..., 'standalone')`.
- Add an equivalence test (`tests/`) for host-lane parity.
- CI standalone lane: expect ~150–186 flips in `built-ins/TypedArray` +
  `built-ins/Array`.

### Classification

**fable-executable-now** — single dispatch-arm addition after a bounded WAT
diagnosis; verified minimal repro included.

## Implementation Notes (2026-07-12, sendev-3164)

**The architect's root-cause hypothesis was WRONG — corrected by WAT diagnosis
before implementing** (verify-first): the dynamic indexed READ dispatch is
fine. The bug is at the WRITE side: `emitArrayCallbackArgsPlumbing`
(array-methods.ts, #820l) builds the extras vec for the inlined array-HOF
callback dispatch, and its element slot went through `emitElemBoxToExternref`
— a documented STUB that emitted `array.get → drop → ref.null.extern` ("the
value is unused inside the body" — false for the predicate-call-parameters
family). So `arguments[0]` inside `sample.findIndex(function(){...})` was
undefined→0 even read DIRECTLY inside the callback; no readback involved.
Probe matrix: direct-call closures and declarations were always fine — only
the inlined HOF-callback dispatch dropped the element (the index right after
it was boxed correctly via `__box_number`).

**Fix**: `emitElemBoxToExternref` now boxes by the backing array's element
ValType — f64 → `__box_number`; i32 / packed i8/i16 (loaded as i32 via
`array.get_s/u`) → `f64.convert_i32_s` + box; ref/ref_null →
`extern.convert_any`; externref as-is; unboxable kinds keep the undefined
placeholder. `$Hole` sentinels ride through unmapped (same visibility as
before; noted boundary).

**Validated**: all 4 `built-ins/Array/prototype/{find,findIndex,findLast,
findLastIndex}/predicate-call-parameters.js` flip fail→pass standalone;
tests/issue-3165.test.ts (6 cases, host-free + host parity).

**Residual — TypedArray half (~most of the 186)**: TypedArray HOFs route
through the host `__make_callback` bridge, which cannot set the wasm-side
`__argc`/`__extras_argv` globals — `results` stays empty there
(`env: __make_callback`, r0 == null). Needs the bridge retirement /
native TypedArray HOF dispatch (#2903 family), NOT this plumbing. Filed as
follow-up scope; do not re-open this issue for it.
