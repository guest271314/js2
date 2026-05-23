---
id: 1130
title: "Array methods — getter-observing property access on indices and length"
status: ready
created: 2026-04-20
updated: 2026-05-23
priority: medium
feasibility: hard
reasoning_effort: high
goal: property-model
---
# #1130 — Array methods: getter-observing property access on indices and length

## Problem

**~80 test262 failures** in `assertion_fail / /Array/prototype/{forEach,map,every,some,filter,reduce,reduceRight}/` install a getter via `Object.defineProperty` on an array index or the `length` property, and expect the getter to fire when the Array iteration method accesses that slot:

```js
var accessed = false;
var arr = [0, 1, 2];
Object.defineProperty(arr, "1", {
  get: function () {
    accessed = true;
    return 99;
  },
});
arr.forEach(function (v) {
  /* ... */
});
assert(accessed, "accessed !== true"); // fails — our impl reads data[1] directly, bypassing getter
```

Spec §23.1.3.{method} — each step calls `HasProperty(O, ! ToString(ℱ(k)))` and `Get(O, ! ToString(ℱ(k)))`, which invoke accessor getters when present. Our `src/codegen/array-methods.ts` generates a tight Wasm loop that reads from the underlying `array.get` instruction — no accessor machinery.

Same mechanism for `length`:

```js
Object.defineProperty(arr, "length", {
  get: function () {
    lengthAccessed = true;
    return 2;
  },
});
```

## Scope

- **~80 tests** — auto-classified with the regex `Object\.defineProperty\([^)]+, "(?:\d+|length)", .*get:` + `accessed|testResult`.
- Covers forEach, map, every, some, filter, reduce, reduceRight.
- Related: 68 "accessed !== true" + 7 "lengthAccessed !== true" + portions of "testResult" variants.

## Why this is hard

1. **Indexed access currently goes to `struct.get`/`array.get` directly.** No [[Get]] semantics.
2. **Spec-compliant iteration** requires HasProperty + Get for every index from 0 to ToLength(O.length). Each of those can trigger a user getter.
3. **`length` coercion** — ToLength(O.length) also goes through a Get. If length has a getter that returns a non-number (e.g. string `"2"` in filter/15.4.4.20-3-11.js), ToLength must still produce `2`.
4. Touches the property-access machinery (`src/codegen/property-access.ts`, `src/codegen/object-ops.ts`) — any change must keep the fast-path for real Arrays without accessors.
5. Interacts with **#1129 array-like receiver** (pattern B) — both need a general "read element via [[Get]]" primitive; fix for B may pave the way for A.

## Sample failing tests

- `test/built-ins/Array/prototype/reduceRight/15.4.4.22-5-10.js` (getter on `length`, ToLength(getter result) expected)
- `test/built-ins/Array/prototype/every/15.4.4.16-7-b-3.js` (getter on index, flag check)
- `test/built-ins/Array/prototype/forEach/15.4.4.18-7-b-15.js` (getter on `"1"`, flag check)

All three FAIL today (codes 2 or 3) — confirmed via compile-verify probe.

## Implementation sketch (needs architect spec)

1. **Runtime representation** — for arrays that have had `defineProperty` called on an own index or `length`, flip a "has-accessors" bit in the vector struct. Fast-path: no-accessors → current direct read.
2. **Slow-path**: when accessors present, iterate via a host-bridge or Wasm-native [[Get]] that checks for an accessor descriptor and invokes the getter closure.
3. **`length` descriptor** — extend the vec struct to carry an optional length-accessor descriptor, or route length reads through a general property-access helper.
4. **ToLength coercion on getter result** — piggyback on the existing number-coercion path used by array bracket access.

## Acceptance criteria

- [ ] **Architect spec**: where the accessor descriptor lives on the vec struct, the fast-path/slow-path branching, how each callback method's loop is adjusted, interaction with `Array.prototype.X.call(plainObj, cb)` (issue #1131 — the B fix).
- [ ] **Regression test** `tests/issue-1130.test.ts` — one test per getter-on-index, getter-on-length, getter returning non-number with ToLength coercion, forEach/map/filter/every/some/reduce/reduceRight.
- [ ] **≥60 of 80 target tests** flip from FAIL to PASS.

## Related

- Probe report: `.tmp/array-callback-probe.md` in worktree `issue-cluster-b-dstr`
- Sub-pattern A of the array-proto-callback cluster (parent: 874 assertion_fail tests).
- Related: #1129 (thisArg ABI), #1131 (array-like receiver via .call).
- Spec: <https://tc39.es/ecma262/#sec-array.prototype.foreach> and siblings.

## Dispatch notes

Route to architect for implementation spec. `reasoning_effort: high`. Recommend **filing after #1131 lands** — if the B fix introduces a general "[[Get]](O, k)" helper, this issue can reuse it for the slow-path.

## Implementation Plan

> **Revision 2 (Author: architect, 2026-05-23).** Supersedes the
> 2026-05-21 draft below the line. The earlier draft proposed adding
> two new fields to the vec struct (`$flags`, `$lenDesc`) and a
> bespoke `__array_get_via_get`. That is **rejected** — it is far more
> invasive than necessary and was written against an inaccurate model
> of the runtime. Reality (verified against current `src/runtime.ts`
> and `src/codegen/array-methods.ts`):
>
> 1. Vec structs are **already** WasmGC structs recognised by
>    `_isWasmStruct` (runtime.ts:812). The vec struct has exactly two
>    fields — `len` (fieldIdx 0, mut i32) and `data` (fieldIdx 1) —
>    and is constructed at dozens of sites (literals, spread,
>    destructuring, map/filter result alloc). Adding fields means
>    touching every `struct.new $vec_*` site plus type-coercion and
>    `getOrRegisterVecType`. Avoid.
> 2. `Object.defineProperty(arr, "1", {get})` already routes through
>    the externref/`__defineProperty_*` path and lands the getter in
>    `_wasmStructProps` keyed by object identity (WeakMap), retrievable
>    via the existing `_safeGet` accessor branch (runtime.ts:1729-1733
>    `__get_<key>`). The accessor machinery already exists; we only
>    need to (a) record that *this array* has an index/length accessor,
>    and (b) make the method loops consult it.

### Strategy: object-identity flag + reuse `_safeGet`

No struct changes. Track "this vec has an own index-or-length
accessor" in a runtime `WeakSet` keyed by the vec ref, and gate a
slow-path loop on a single runtime `i32` query.

### Changes

**File: `src/runtime.ts`**

1. Add a module-level `const _arrayHasAccessor = new WeakSet<object>();`
   (near `_wasmStructProps`, runtime.ts:48).
2. In the `Object.defineProperty` accessor path (the code that writes
   `__get_<key>` / accessor descriptors — see `_safeGet` consumers and
   `__defineProperty_accessor`), after the descriptor is recorded, if
   the *receiver* is a vec (`_isWasmStruct(obj)` and it is array-typed)
   **and** the key is a canonical array index string (`String(ToUint32(k)) === k`)
   **or** the key is `"length"`, call `_arrayHasAccessor.add(obj)`.
   Do the same for the data-descriptor path so a `defineProperty` with
   `{value}` on an index that *shadows* a getter is handled — but the
   common failing case is the accessor descriptor.
3. Export two host helpers (import them in codegen like the existing
   `__defineProperty_value`):
   - `__array_has_accessor(arr: externref): i32` → returns
     `_arrayHasAccessor.has(arr) ? 1 : 0`.
   - `__array_get_elem(arr: externref, index: f64): externref` →
     spec-compliant per-index [[Get]]:
     ```ts
     function __array_get_elem(arr, index) {
       // _safeGet already checks the __get_<key> accessor sidecar,
       // then falls through to native indexed read of the vec.
       return _safeGet(arr, index);   // index is a number; _safeGet stringifies as needed
     }
     ```
     `_safeGet` (runtime.ts:1700) already: checks the accessor getter
     (`__get_<index>`) and invokes it (`.call(obj)`), else reads the
     element. This is exactly [[Get]] for our purposes.
   - `__array_get_length(arr: externref): f64` → returns
     `ToLength` of `Get(arr, "length")`:
     ```ts
     function __array_get_length(arr) {
       const lenGetter = /* __get_length accessor on arr, if any */;
       const raw = lenGetter ? lenGetter.call(arr) : _vecLen(arr);
       // ToLength: ToNumber → if NaN→0, → trunc → clamp [0, 2^53-1]
       let n = Number(raw);
       if (Number.isNaN(n)) return 0;
       n = Math.trunc(n);
       if (n <= 0) return 0;
       return Math.min(n, 2 ** 53 - 1);
     }
     ```
     Reuse the existing length getter lookup (`_wasmStructProps.get(arr)?.["__get_length"]`).
   - `__array_has_elem(arr: externref, index: f64): i32` →
     HasProperty: returns 1 if there is an own accessor for that index
     **or** the index is `< vecLen` (dense element present), else 0.
     Needed so `forEach`/`every`/`some` correctly *skip* holes per spec.

**File: `src/codegen/array-methods.ts`**

The two loop families both currently read `data[i]` via `array.get`
with no [[Get]]:

- **Shared-helper family** (preferred refactor point): `setupArrayLoop`
  (line ~4472) + `buildClosureCallInstrs` (line ~4513) — used by
  `compileArrayMap` (4803), `compileArrayFilter` (4717),
  `compileArrayReduce` (4904), `compileArrayReduceRight` (5026),
  `compileArrayForEach` (5193), `compileArrayFind` (5236),
  `compileArrayFindIndex` (5314), `compileArraySome` (5382),
  `compileArrayEvery` (5444).
- **Legacy per-method family** (`.call`-receiver variants):
  `compileArrayPrototypeForEach` (2187), `compileArrayPrototypeEvery`
  (1923), `compileArrayPrototypeSome` (2065). These already coordinate
  with #1131 (array-like receiver); leave them to #1131's helper and
  focus this issue on the shared-helper family which covers the literal
  `[...].forEach(cb)` test262 cases.

**The fast/slow branch.** Wrap the existing loop emission in a runtime
guard. In each `compileArrayX` that uses `setupArrayLoop`:

```
;; after setupArrayLoop, before the loop block:
local.get $vecTmp
extern.convert_any                 ;; vec ref → externref (existing coerceType path)
call $__array_has_accessor         ;; i32: 1 if this array has index/length accessor
if (result <method-result>)
  ;; SLOW PATH — spec-compliant
  ;; len = (i32) __array_get_length(vec)          ; observes length getter + ToLength
  ;; for i in 0..len:
  ;;   if __array_has_elem(vec, i):               ; HasProperty — skip holes
  ;;     elem = __array_get_elem(vec, i)          ; [[Get]] — fires index getter
  ;;     <coerce externref → elemType>            ; coercionInstrs / __unbox
  ;;     <buildClosureCallInstrs with elem as a local>
else
  ;; FAST PATH — the existing tight array.get loop, unchanged
end
```

Implement the slow path as a new helper `emitSlowArrayLoop(ctx, fctx,
setup, loop, …, body)` parameterised by the same per-method tail logic
the fast path uses (push result, accumulate, set flags, etc.). To keep
the diff bounded, the slow path may **box every element to externref**
and reuse `buildClosureCallInstrs` with `elemSource = {kind:"local"}`
pointing at an externref temp that is `__unbox`/coerced to the
callback's declared param type via `coercionInstrs`.

For `map`/`filter` the result vec is still built with the existing
externref/typed element path. For `reduce`/`reduceRight` the
accumulator handling is identical; only the element read changes.

### Where the accessor flag is recorded (codegen side, optional)

The flag is recorded purely in `runtime.ts` (step 2 above) at the
moment `Object.defineProperty` runs — no compile-time knowledge needed,
because the failing tests always call `defineProperty` at runtime. The
codegen `compileObjectDefineProperty` (object-ops.ts:442) already routes
array+accessor descriptors through `__defineProperty_accessor`
(object-ops.ts:1690), so the runtime hook in step 2 fires automatically.
**No codegen change needed at the defineProperty site.**

### Wasm IR pattern (length read, slow path)

```wat
local.get $vecTmp
extern.convert_any
call $__array_get_length      ;; f64
;; ToLength already applied in the helper
i32.trunc_sat_f64_u           ;; f64 → i32 loop bound (safe, helper clamped)
local.set $lenTmp
```

### Edge cases

- **Getter throws** → propagates via existing exception machinery
  (host call unwinds). No special handling.
- **Sparse / hole skipping** — `forEach`/`every`/`some`/`reduce` must
  NOT invoke the callback for missing indices. The slow path gates each
  iteration on `__array_has_elem`. `map`/`filter` preserve holes in the
  result (filter: hole → not included; map: hole → hole, but our dense
  vec has no true holes — acceptable, matches V8 for non-sparse input).
- **`length` getter returns non-number** (e.g. string `"2"`) — handled
  by `ToLength` in `__array_get_length` (`Number("2")` → 2).
- **`length` getter returns `NaN`/negative/Infinity** → ToLength yields
  0 / 0 / 2^53-1 (clamped). Loop bound is `i32.trunc_sat` so it never
  traps; the per-index `__array_has_elem` keeps reads in range.
- **Getter returns `undefined`** — callback still invoked with
  `undefined`; do NOT skip (distinct from a hole — `__array_has_elem`
  returns 1 because the accessor *exists*).
- **`reduce`/`reduceRight` with no initial value on an
  all-getter/empty array** → throws `TypeError` per spec; the slow path
  mirrors the existing fast-path TypeError emission.
- **Mutation during iteration** — length is snapshotted once at loop
  entry (matches the fast path and V8). Index getters that mutate the
  array are observed only for indices not yet read.
- **Accessor installed then deleted** — `delete arr[1]` removing the
  getter: out of scope; `_arrayHasAccessor` stays set (conservative →
  slow path, still correct, just slower). Acceptable.
- **`.call(plainObject, cb)` receiver** — NOT this issue; #1131 owns
  the array-like receiver path. Coordinate so both reuse
  `__array_get_elem` / `__array_get_length`.

### Fast-path preservation

The guard is one host call (`__array_has_accessor`) per method
invocation (not per element). For arrays without accessors it returns 0
and the unchanged tight `array.get` loop runs. The host-call overhead is
amortised over the whole iteration — negligible. Crucially, **no struct
field is added**, so dense-array construction and the hot inner loop are
byte-for-byte identical to today.

### Test plan

Regression test `tests/issue-1130.test.ts` — one assertion per:
- getter on a numeric index fires under forEach/map/filter/every/some/
  reduce/reduceRight (the `accessed === true` shape);
- getter on `length` fires and drives the loop bound
  (`lengthAccessed === true`);
- length getter returning a string `"2"` iterates exactly twice
  (ToLength coercion);
- hole skipping: `every` does not call the callback for a deleted index;
- a dense array with no accessors still produces identical output and
  takes the fast path (sanity).

Test262 paths to verify flip FAIL→PASS:
- `test/built-ins/Array/prototype/forEach/15.4.4.18-7-b-15.js`
- `test/built-ins/Array/prototype/every/15.4.4.16-7-b-3.js`
- `test/built-ins/Array/prototype/reduceRight/15.4.4.22-5-10.js`
- broad: `test/built-ins/Array/prototype/{forEach,map,every,some,filter,reduce,reduceRight}/15.4.4.*` matching the `accessed`/`lengthAccessed`/`testResult` patterns.

Acceptance: ≥60 of the ~80 target tests pass.

### Dependencies / coordination

- **#1131** (array-like receiver via `.call`) — share
  `__array_get_elem` / `__array_get_length` / `__array_has_elem`. If
  #1131 lands first, this issue consumes its helpers; if this lands
  first, #1131 reuses these. Either order works since the helpers are
  receiver-agnostic (they take an externref).
- **#739 / #929** (Object.defineProperty correctness/receiver
  validation) — the runtime flag hook (step 2) lives adjacent to that
  code; harmless overlap, coordinate the WeakSet add.

### Risks

- **Slow-path correctness over fast-path coverage** — the slow path is
  only exercised when an accessor was installed, so a bug there cannot
  regress the 99% dense-array case. Lowest-risk shape.
- **Boxing in the slow path** — boxing every element to externref costs
  allocations, but only on arrays that already opted into accessors
  (already slow by nature). Acceptable.
- **`i32.trunc_sat_f64_u` bound** — relies on the helper clamping; if a
  future change removes the clamp, a huge `length` getter could spin.
  Keep the `Math.min(n, 2**53-1)` clamp and rely on `__array_has_elem`
  bounding actual reads.

---

<details><summary>Superseded draft (2026-05-21) — kept for history</summary>

(Author: architect, 2026-05-21. Builds on the sketch above; adds
exact struct field, branch placement, and the `__array_get_via_get`
helper. **Rejected in favour of Revision 2 — struct-field surgery
is unnecessarily invasive.**)

Proposed adding `$flags`/`$lenDesc` fields to the vec struct and a
`__array_get_via_get` helper checking `_sidecarGet(arr, "__get_"+key)`.
See git history for the full text.

</details>
