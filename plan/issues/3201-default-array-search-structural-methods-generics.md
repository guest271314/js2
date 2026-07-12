---
id: 3201
title: "default lane: Array.prototype search + structural generics (indexOf/lastIndexOf/slice/splice/sort/concat/pop) (~312 fails)"
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
related: [3185, 3169, 3180, 2036]
origin: "2026-07-12 Fable codebase audit §F2; method-family slice of #3185"
---

# #3201 — default-lane Array search + structural generics (~312)

Method-family slice **C** of **#3185** (default JS-host lane). Covers the
non-callback search + structural family: **splice (63) + lastIndexOf (50) +
indexOf (48) + slice (48) + sort (45) + concat (45) + pop (13) = ~312**
non-pass (baseline 2026-07-12).

## Not overlapping #3169/#3180

#3169/#3180 cover the **seven callback HOF families** on the standalone lane —
this slice's methods (indexOf/lastIndexOf/slice/splice/sort/concat/pop) are
**not** in that set and are on the **default JS-host lane**. Disjoint on both
axes. sort's callback comparator is in-scope here (default lane) but is not a
#3169 HOF family.

## Problem mechanisms (from #3185 §F2 error shapes)

1. **Array-like receivers via `.call(obj, …)`** — `Array.prototype.
   {indexOf,lastIndexOf}.call(arrayLike)` (13 + 12 measured shapes); the host
   externref path (`ARRAY_LIKE_METHOD_SET`, `array-methods.ts:668`) misses
   spec ordering/coverage.
2. **Observable + coercion semantics** — `fromIndex`/`start`/`deleteCount`
   ToInteger coercion, HasProperty-before-Get, `SameValueZero` vs strict
   equality (indexOf/lastIndexOf), length caching.
3. **Result-object fidelity** — `newArr.length` mismatch (28),
   `Object.getPrototypeOf(result)` mismatch (8): length / prototype / species
   of slice/splice/concat results.
4. **Hard traps (30 family-wide, umbrella-priority)** — `illegal cast [in
   test()]` (16) + `array element access out of bounds [in test()]` (14) are
   soundness-adjacent (uncatchable, abort whole tests). Per #3185 §4 these are
   the FIRST priority: every trap in this family's tests must become a spec
   value or a thrown JS TypeError, never a Wasm trap. Coordinate with
   #3179/#3162 mechanism notes.

## Reproduction path (verified anchors)

- Direct real-array impls: `compileArrayIndexOf` (`array-methods.ts:4462`),
  `compileArrayLastIndexOf` (`:9292`), `compileArraySlice` (`:5438`),
  `compileArraySplice` (`:6239`), `compileArraySort` (`:8285`),
  `compileArrayConcat` (`:5550`) / `compileArrayConcatExtern` (`:5680`),
  `compileArrayPop` (`:5100`).
- Array-like `.call` generic path: `compileArrayLikePrototypeCall` (`:763`),
  `ARRAY_LIKE_METHOD_SET` (`:668`).

## Acceptance criteria

1. The 30 trap-class fails (illegal cast / OOB) across this family → 0 traps
   (spec result or thrown JS TypeError). **Land this sub-bucket first.**
2. Root-cause note per mechanism sub-bucket, with the measured test list from
   the baseline jsonl (recompute — main moves).
3. ≥ 150 of the ~312 family records flip to genuine pass on the default lane.
4. Result-object length/prototype fidelity holds for slice/splice/concat.
5. No standalone-lane regressions.

## Coordination (hot file)

`src/codegen/array-methods.ts` is shared with #3199/#3200, epic S3 #3193 /
S6 #3196, and dev-array-hof. Behavioral fixes only; re-anchor by symbol;
re-merge `origin/main` before enqueue.
