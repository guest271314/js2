---
id: 3215
title: "standalone: Array.prototype HOF sparse-array read trap-safety (forEach/map/filter/reduce/every/some/find/findIndex/findLast/findLastIndex)"
status: done
completed: 2026-07-13
created: 2026-07-13
priority: high
feasibility: medium
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: 71
horizon: m
related: [3185, 3199, 3200, 3201, 2001]
loc-budget-allow: [src/codegen/array-methods.ts]
origin: "2026-07-13 opus-3201b — HOF analog of the #3201 sort/includes sparse-read trap fix (#2980)"
---

# #3215 — Array.prototype HOF sparse-array read trap-safety

Analog of the #3201 read/copy trap-safety family (#2968 indexOf/lastIndexOf,
#2970 slice/concat, #2973 pop/splice, #2980 sort/includes), now for the
callback HOF family. On a SPARSE array (logical `.length` set beyond the
physical WasmGC backing) these methods iterate to the LOGICAL length reading
`data[i]` with a raw `array.get`, which TRAPS ("array element access out of
bounds") once `i` passes the backing length — an uncatchable Wasm trap that
aborts the whole test262 program (the #3185 §4 trap-first mandate).

Confirmed (standalone, `[1,2,3]; a.length=6`): forEach, map, filter, every,
reduce all TRAP; some returns early before reaching the hole.

## Root cause (shared loop scaffolding)

All forward HOFs build their iteration through `setupArrayLoop`
(`array-methods.ts`), which reads `lenTmp = struct.get field0` (LOGICAL length)
and `loopExitCheck` compares `i >= lenTmp`. `setupArrayLoopReverse` starts
`i = lenTmp - 1`. The element read `data[i]` therefore runs past
`array.len(data)` on a sparse receiver → trap.

Consumers of `setupArrayLoop`: filter, map, reduce, forEach, find, findIndex,
some, every (+ `setupArrayLoopReverse`: findLast, findLastIndex).

## Fix

Clamp the loop bound to the physical backing centrally in `setupArrayLoop`:
`lenTmp = min(lenTmp, array.len(dataTmp))` (reuse the `min` shape from the
merged indexOf/sort clamps). This fixes every forward + reverse consumer in one
place. Per spec these HOFs use HasProperty (holes are SKIPPED), so iterating only
the physical defined prefix and skipping the beyond-backing holes is
spec-correct AND trap-free. Dense arrays keep `lenTmp` unchanged (backing ≥
length ⇒ runtime no-op).

**map result-length caveat**: `compileArrayMap` allocates its result via
`array.new_default(loop.lenTmp)` and sizes the result vec from it — the result
must keep the LOGICAL length (§23.1.3.19), holes preserved beyond the visited
prefix. So `setupArrayLoop` must ALSO expose the UNCLAMPED logical length
(`logicalLenTmp` added to `ArrayLoopLocals`); map uses `logicalLenTmp` for its
result allocation + vec length, and the clamped `lenTmp` for the loop bound.
Beyond-backing result slots stay default-initialised (consistent with the
existing #2001-S2 deferred map-result-hole behavior — not made worse).

filter builds its result dynamically (push kept elements), so the clamp is
correct as-is (holes contribute nothing). reduce with no initial value still
seeds from `data[0]` (in-backing) and skips beyond-backing holes (spec-correct).

## Acceptance

1. forEach/map/filter/reduce/every/some/find/findIndex/findLast/findLastIndex on
   a sparse array → NO trap; spec-correct result (holes skipped / map keeps
   logical length).
2. Dense arrays behaviourally unchanged.
3. Dedicated `tests/issue-3215-hof-sparse.test.ts`, standalone lane.
4. No standalone-lane regressions.

## Out of scope (follow-ups)

- map/filter/flatMap RESULT-HOLE fidelity (source hole → result hole per
  §23.1.3.19) — the #2001-S2 deferred widened-result-type slice.
- flatMap sparse (if it uses a distinct loop) — verify separately.
- Array-like `.call(obj)` HOF sparse receivers — the #3169/#3200 receiver-ladder.
