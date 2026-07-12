---
id: 3185
title: "UMBRELLA default lane: Array.prototype generics + observable-semantics cluster (~1,057 fails — largest untracked builtin bucket)"
status: ready
created: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: current
horizon: l
related: [3169, 3170, 3180, 2036, 3022, 1589]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, §F2)"
---

# #3185 — UMBRELLA: default-lane Array.prototype generics + observability (~1,057)

## Problem

`built-ins/Array` is the **largest built-ins fail bucket on the default
(JS-host) lane** — **1,057 non-pass** (baseline 2026-07-12) — yet has no open
default-lane issue: the 2026-07-03 harvest filed class/defineProperty/
iterator/invalid-wasm/with/negative buckets and skipped Array, and every open
Array HOF issue (#3169/#3170/#3180/#2036) is `--target standalone`.

Sub-buckets (non-pass per method directory):

```
90 reduceRight   88 reduce   69 map   68 filter   63 splice
54 some   53 forEach   51 every   50 lastIndexOf   48 indexOf
48 slice   45 sort   45 concat   14 flatMap   13 pop
```

Top error shapes across those method dirs (mechanism signal):

```
111  assert(testResult, 'testResult !== true')          ← callbackfn arg/return semantics
 33  assert(accessed, 'accessed !== true')              ← accessor/get observation order
 28  newArr.length mismatch                              ← result length/species
 21  "object is not a function"                          ← callable mis-dispatch
 16  illegal cast [in test()]                            ← uncatchable trap
 14  array element access out of bounds [in test()]      ← uncatchable trap
 13/13/12/7  Array.prototype.{indexOf,every,lastIndexOf,reduce}.call(arrayLike)
  8  callCnt mismatch                                    ← visit-count (holes/mutation)
  8  Object.getPrototypeOf(result) mismatch              ← species/proto
```

## Mechanisms (slice this umbrella by mechanism, not by method)

1. **Array-like receivers via `.call(obj, …)`** — the externref-receiver path
   exists (`ARRAY_LIKE_METHOD_SET`, `src/codegen/array-methods.ts:668`; thisArg
   handling `:692`) but misses spec ordering/coverage the tests check.
2. **Observable semantics on real arrays** — HasProperty/Get ordering, hole
   skipping vs visiting, length caching, mutation-during-iteration
   (`accessed`, `callCnt`, `testResult` shapes).
3. **Result-object fidelity** — length, prototype, species of map/filter/
   slice/splice/concat results.
4. **Hard traps (30)** — 16 illegal_cast + 14 OOB inside `test()`; these are
   soundness-adjacent (uncatchable, abort whole tests) and should be the FIRST
   slice. Coordinate with #3179/#3162 mechanism notes.

## Notes

- `src/codegen/array-methods.ts` is 9,632 LOC and inside the #3182 bloat
  epic's blast radius — land slices here as *behavioral* fixes, coordinate
  refactors with #3182/#3105.
- reduce/reduceRight (178 combined — the two biggest dirs) have a documented
  exclusion note at `src/codegen/array-methods.ts:664-666` (different callback
  signature on the array-like path) — a known-incomplete edge.

## Acceptance criteria (umbrella)

1. Child slices filed per mechanism above (trap slice first), each with
   measured test lists pulled from the baseline jsonl.
2. `built-ins/Array` default-lane non-pass < 600 (from 1,057) when the
   mechanism slices land.
3. The 30 trap-class fails (illegal cast / OOB) → 0 traps (spec result or
   thrown JS TypeError, never a Wasm trap).
4. No standalone-lane regressions in the #3169/#3180 receiver-ladder tests.

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F2.
