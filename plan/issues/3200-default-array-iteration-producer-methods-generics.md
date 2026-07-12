---
id: 3200
title: "default lane: Array.prototype iteration/producer generics (forEach/map/filter/flatMap) over real + array-like receivers (~204 fails)"
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

# #3200 — default-lane Array iteration/producer generics (~204)

Method-family slice **B** of **#3185** (default JS-host lane). Covers the
callback iteration/producer family: **map (69) + filter (68) + forEach (53) +
flatMap (14) = ~204** non-pass (baseline 2026-07-12).

## Not overlapping #3169/#3180

#3169 (done) / #3180 (residual) cover map/filter/forEach on the
**`--target standalone`** lane. This slice is the **default JS-host lane** —
disjoint by construction. flatMap is NOT in the #3169 seven-family set at all,
so it is untracked on both lanes; keep the flatMap fix host-lane here and file
a standalone follow-on if it diverges.

## Problem mechanisms (from #3185 §F2 error shapes)

1. **Observable semantics on real arrays** — callbackfn arg/return
   (`testResult !== true`), accessor/get observation order (`accessed`), hole
   skip-vs-visit, `callCnt` under mutation-during-iteration, length caching.
2. **Result-object fidelity** — `newArr.length` mismatch (28),
   `Object.getPrototypeOf(result)` mismatch (8): length / prototype / species
   of the map/filter/flatMap result arrays.
3. **Array-like receivers via `.call(obj, …)`** — the host externref path
   (`ARRAY_LIKE_METHOD_SET`, `array-methods.ts:668`; thisArg `:996-1020`)
   misses spec coverage for these methods.
4. **Hard traps** — any `illegal cast` / OOB `[in test()]` under these methods
   must resolve to spec value or thrown TypeError, never a Wasm trap
   (umbrella trap-first mandate, #3185 §4).

## Reproduction path (verified anchors)

- Direct real-array impls: `compileArrayMap` (`array-methods.ts:7205`),
  `compileArrayFilter` (`:7116`), `compileArrayForEach` (`:7715`),
  `compileArrayFlatMap` (`:9561`).
- Array-like `.call` generic path: `compileArrayLikePrototypeCall` (`:763`),
  `ARRAY_LIKE_METHOD_SET` (`:668`).

## Acceptance criteria

1. Root-cause note per mechanism sub-bucket, with the measured test list from
   the baseline jsonl (recompute — main moves).
2. ≥ 110 of the ~204 family records flip to genuine pass on the default lane.
3. Result-object length/prototype fidelity holds for map/filter/flatMap.
4. Zero Wasm traps; no standalone-lane regressions.

## Coordination (hot file)

`src/codegen/array-methods.ts` is shared with #3199/#3201, epic S3 #3193 /
S6 #3196, and dev-array-hof. Behavioral fixes only; re-anchor by symbol;
re-merge `origin/main` before enqueue.
