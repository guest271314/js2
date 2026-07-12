---
id: 3199
title: "default lane: Array.prototype fold/predicate generics (reduce/reduceRight/every/some) over real + array-like receivers (~283 fails)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: current
horizon: m
umbrella: 3185
related: [3185, 3169, 3180, 3015, 3170]
origin: "2026-07-12 Fable codebase audit §F2; method-family slice of #3185"
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
