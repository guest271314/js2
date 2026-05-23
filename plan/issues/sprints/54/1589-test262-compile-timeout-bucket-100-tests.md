---
id: 1589
title: Investigate 100 test262 tests that hit the 30s compile_timeout ceiling
status: ready
sprint: 54
priority: medium
feasibility: medium
type: perf
labels: [test262, ci, compiler-perf]
---

## Problem

100 tests in `benchmarks/results/test262-current.jsonl` carry `status:
compile_timeout` with `compile_ms: 30000, exec_ms: 0`. They all pin the
vitest per-test timeout (30 s) and never finish compiling. They are spread
across 13+ areas of the test262 corpus, so this is not a single missing
feature — it's likely a small handful of compiler hot spots (parser bombs,
runaway analysis, infinite recursion in IR lowering) each catching many
related tests.

Impact on CI wall time:
- In the 115-shard run, the worst shards were dominated by 3 × 30 s
  timeouts each (= 90 s of the ~100 s shard wall time, validated against
  the committed baseline).
- The recent slow-test sorting PR (`slow-lane-shard`) puts these tests
  at the start of each shard so they overlap with the rest of the
  fork-pool work, but they still cost 30 s of fork time each.
- Resolving them would shave significant fork-time and cut the longest
  shard back to the level of the median (~50–69 s).

## Hot buckets (count, path prefix)

```
 18  test/built-ins/Array
 13  test/built-ins/Object
  9  test/built-ins/Temporal
  7  test/built-ins/String
  5  test/built-ins/Promise
  5  test/built-ins/TypedArrayConstructors
  4  test/built-ins/RegExp
  4  test/built-ins/Set
  4  test/built-ins/TypedArray
  4  test/language/function-code
  3  test/annexB/language
  2  test/built-ins/{JSON,Math,Iterator,DataView}
  2  test/annexB/built-ins
  ≤1 misc (Map, parseFloat, Proxy, Date, encodeURI, Symbol, Reflect,
       WeakMap, Function, Number, …)
```

Sample test paths (full list: pull `compile_timeout` entries from
`benchmarks/results/test262-current.jsonl`):

```
test/built-ins/Array/prototype/reduce/15.4.4.21-1-11.js
test/built-ins/Array/prototype/with/name.js
test/built-ins/Object/defineProperties/15.2.3.7-5-b-39.js
test/built-ins/Promise/any/ctx-non-ctor.js
test/built-ins/RegExp/property-escapes/generated/Script_-_Bengali.js
test/built-ins/String/prototype/replaceAll/searchValue-replacer-call-abrupt.js
test/built-ins/Temporal/Duration/prototype/subtract/argument-mixed-sign.js
test/language/function-code/10.4.3-1-71-s.js
test/annexB/language/eval-code/direct/func-block-decl-eval-func-skip-early-err-for-of.js
```

## Investigation plan

1. Run a single timeout test under a much longer ceiling
   (`COMPILER_POOL_SIZE=1` + 5-minute timeout) to determine whether it
   eventually finishes (= O(N²) or worse parser/IR pathology) or truly
   loops forever (= bug).
2. Group by suspected root cause:
   - Tests that import `_FIXTURE.js` with deeply-nested classes
   - Tests using `assert.throws` patterns we mis-classify as type
     narrowing
   - Generated `property-escapes` tests that may explode regex
     compilation
   - `Temporal/*` tests that hit the prototype chain hard
3. Either:
   - Fix the compiler hot spot (preferred — restores real conformance)
   - Add a narrow skip rule with a back-pointer to the root-cause issue
     (acceptable if the fix is in a much larger refactor)

## Acceptance criteria

- ≤ 20 tests remain at `compile_timeout` in the next baseline refresh
- Per-shard p95 wall time ≤ 70 s on the 115-shard matrix
- Root-cause issues filed for the remaining timeouts

## Related

- `slow-lane-shard` PR — within-shard sorting by descending duration so
  these timeouts run first in each shard, surfacing them early in CI
  logs and overlapping their wall time with the rest of the shard.
- `tests/test262-slow-tests.json` — the duration map (also contains these
  timeouts, sorted to the top of each shard).
- `scripts/refresh-slow-tests.mjs` — regenerates the map from the
  committed baseline JSONL.
