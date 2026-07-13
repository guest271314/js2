---
id: 3199
title: "default lane: Array.prototype fold/predicate generics (reduce/reduceRight/every/some) over real + array-like receivers (~283 fails)"
status: done
completed: 2026-07-12
created: 2026-07-12
updated: 2026-07-13
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: 71
horizon: m
umbrella: 3185
related: [3185, 3169, 3180, 3015, 3170]
origin: "2026-07-12 Fable codebase audit §F2; method-family slice of #3185"
# (#3131) Behavioral fix: the reduce/reduceRight accumulator-seed helper
# (initArgIsReference + resolveReduceAccType) adds a small, self-contained
# amount to the already-over-threshold array-methods.ts. Genuine growth for a
# correctness fix; the file's shrink is tracked by the #3182/#3105 splits.
loc-budget-allow:
  - src/codegen/array-methods.ts
---

# #3199 — default-lane Array fold/predicate generics (~283)

Method-family slice **A** of **#3185** (default JS-host lane). Covers the
callback fold/predicate family: **reduceRight (90) + reduce (88) + some (54) +
every (51) = ~283** non-pass (baseline 2026-07-12).

## Not overlapping #3169/#3180

#3169 (done) and #3180 (residual) cover the SAME method family but on the
**`--target standalone`** lane (host-free receiver ladder). This slice is the
**default JS-host lane** — disjoint test set by construction (host-pass vs
host-fail). Do not touch the standalone `fillExternArrayLikeStructArms` /
`hof-native` emit paths #3169/#3180 own.

## Problem mechanisms (from #3185 §F2 error shapes)

1. **Observable semantics on real arrays** — callbackfn arg/return
   (`testResult !== true`, 111 across the family), accessor/get observation
   order (`accessed !== true`, 33), visit-count under holes/mutation
   (`callCnt`, 8), HasProperty-before-Get, length caching.
2. **Array-like receivers via `.call(obj, …)`** — `Array.prototype.{every,
   reduce}.call(arrayLike)` (13 + 7 measured shapes); the host externref path
   exists (`ARRAY_LIKE_METHOD_SET`, `src/codegen/array-methods.ts:668`; thisArg
   `:692`, install `:996-1020`) but misses spec ordering/coverage.
3. **Hard traps in this family** — any `illegal cast [in test()]` /
   `array element access out of bounds [in test()]` under these methods must
   resolve to the spec value or a thrown JS TypeError, **never a Wasm trap**
   (umbrella trap-first mandate, #3185 §4).

## Reproduction path (verified anchors)

- Direct real-array impls: `compileArrayReduce` (`array-methods.ts:7357`),
  `compileArrayReduceRight` (`:7506`), `compileArraySome` (`:8154`),
  `compileArrayEvery` (`:8219`).
- Array-like `.call` generic path: `compileArrayLikePrototypeCall` (`:763`),
  gated by `ARRAY_LIKE_METHOD_SET` (`:668`). Note the reduce/reduceRight
  exclusion documented at `:664-666` ("different callback signature (acc,
  elem, i, arr) — handled by `__proto_method_call`") — a known-incomplete edge
  to close for the `.call` fold sub-bucket.

## Acceptance criteria

1. Root-cause note per mechanism sub-bucket, with the measured test list
   pulled from the baseline jsonl (recompute — main moves).
2. ≥ 150 of the ~283 family records flip to genuine pass on the default lane.
3. Zero Wasm traps under this family (spec value or thrown TypeError).
4. No standalone-lane regressions (#3169/#3180 receiver-ladder tests).

## Coordination (hot file)

`src/codegen/array-methods.ts` (9,632 LOC) is shared with #3200/#3201 (sibling
slices), epic S3 #3193 / S6 #3196, and dev-array-hof. Land as **behavioral**
fixes; coordinate refactors with #3182/#3105. Re-anchor by symbol; re-merge
`origin/main` before enqueue.

## Resolution (2026-07-12) — bounded in-file fix; bulk re-sliced to #3185

Measured root-cause breakdown of the 281 default-lane fails (fresh-process
probes over the baseline jsonl, reduce/reduceRight/some/every):

- **~102 getter/`defineProperty`/`delete` observation on REAL (vec-backed)
  arrays** — getters/delete never fire on the WasmGC vec, so
  `testResult`/`accessed`/`callCnt`/mutation-during-iteration asserts fail.
  This is the real-array dynamic-property gap **blocked on rep-unification
  #3134**, NOT fixable in `array-methods.ts`. Re-sliced into #3185 as its own
  XL child gated on #3134.
- **~125 `.call(arrayLike)`** — the generic dispatch
  (`compileArrayLikePrototypeCall`) exists but each failing cluster is a
  DISTINCT deep, mostly **cross-file** gap: `instanceof`-on-host-externref
  inside callbacks (`o instanceof Date` → false), Function-value receivers
  (`object is not a function`), etc. Not `array-methods.ts` work — re-sliced
  into #3185 as distinct issues.
- **~46 "simple" direct** — dominated by mutation-during-iteration + mixed
  number/string reduce coercion (e.g. `[1,2,,4,'5'].reduce → "NaN5"` vs
  `"105"`, needs hole-skip + dynamic length re-read + string fold).
- **8 traps** (illegal cast).

**Shipped (this PR):** the one clean, zero-regression fix that lives entirely
in `array-methods.ts` — `resolveReduceAccType` ignored the initial value's
type and defaulted a void/untyped-callback accumulator to f64, so
`[].reduce(function () {}, "seed")` coerced the reference seed to NaN. Now an
explicit reference-typed initial value seeds the accumulator as `externref`
(numeric inits unchanged). Flips test262
`reduce/15.4.4.21-7-10` + `reduceRight/15.4.4.22-7-10`; covered by
`tests/issue-3199.test.ts` (7 cases incl. numeric/string regression guards).

**Not achievable in an M-sized in-file slice:** the ≥150-flip acceptance
requires the XL #3134 real-array-observation feature. Acceptance #3 (zero
traps) and the bulk are tracked under #3185's re-slice.
