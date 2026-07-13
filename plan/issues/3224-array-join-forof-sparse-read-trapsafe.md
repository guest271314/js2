---
id: 3224
title: "standalone: Array join/toString/for-of sparse-array bounds-checked-read trap-safety"
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
related: [3185, 3201, 3215, 2001]
loc-budget-allow: [src/codegen/array-methods.ts, src/codegen/statements/loops.ts]
origin: "2026-07-13 opus-3201b — bounds-checked-read analog of the #3201/#3215 clamp family"
---

# #3224 — Array join/toString/for-of sparse-array read trap-safety

Bounds-checked-read analog of the #3201 clamp family (#2968 indexOf/lastIndexOf,
#2970 slice/concat, #2973 pop/splice, #2980 sort/includes, #2982 HOFs). On a
SPARSE array (logical `.length` set beyond the physical WasmGC backing) these
read `data[i]` up to the LOGICAL length and TRAP ("array element access out of
bounds") once `i` passes the backing — an uncatchable Wasm trap that aborts the
whole test262 program (the #3185 §4 trap-first mandate).

Confirmed (standalone, `[1,2,3]; a.length=6`): `join`, `toString`, and
`for (const x of a)` all TRAP.

## Why a bounds-checked READ, not a clamp

Unlike sort/includes/HOFs (which SKIP absent indices, so a loop-clamp is
spec-correct), `join`/`toString`/`for-of` must VISIT every index up to the
logical length and materialise the absent ones as their spec value:

- `join`/`toString` — §23.1.3.18: an absent index renders as the empty string,
  so `[1,2,3]; a.length=6; a.join(",")` === `"1,2,3,,,"` (three trailing empties).
  A loop-clamp would drop the trailing hole slots → wrong separators.
- `for-of` — the array iterator yields `undefined` for absent indices.

So the fix keeps iterating to the LOGICAL length but makes the element READ
bounds-checked: `if i < array.len(data): data[i]  else: <hole/absent value>`.

## Fix

- **join / toString** (`compileArrayJoin` + `compileArrayJoinNative`, `array-methods.ts`)
  — the shared fold `emitStringJoinFold` (builtin-scaffold.ts) iterates to the
  logical `lenTmp` and delegates the `data[i]` read+stringify to the caller's
  `elemToStr`. Make the read bounds-checked: beyond the backing, push the SAME
  hole sentinel that within-backing holes already use (f64: the sNaN
  `0x7FF00000DEADC0DE` → `""`; externref: undefined/null → `""`), which flows
  through the existing "hole → empty string" rendering. No clamp; fold unchanged.
- **for-of** (`compileForOfArrayTentative` + `compileForOfArrayKeys`/`Entries`,
  `statements/loops.ts`) — the vec index loop reads `data[i]` to the logical
  length; bounds-check the read (beyond backing → `undefined`/absent value).

## Huge-logical-length note

`a.length = 2**32` then join/for-of would iterate ~4e9 times. That is a
pre-existing property of the logical-length loop (not introduced here) and is
degenerate/untested; this slice does NOT add a synthetic cap — it only removes
the trap for the realistic sparse shapes test262 exercises. A cap is a separate
concern if a huge-length test surfaces.

## Acceptance

1. join/toString/for-of on a sparse array → NO trap; spec-correct value
   (join trailing empties; for-of yields undefined for holes).
2. Dense arrays behaviourally unchanged.
3. Dedicated `tests/issue-3224-join-forof-sparse.test.ts`, standalone lane.
4. No standalone-lane regressions.

## Out of scope

- reverse/fill/copyWithin sparse — WRITE-path backing growth (the #3201
  "huge sparse-index WRITE" bucket), not a read fix.
- flat/flatMap — separate standalone feature gap (#2717), refuse (no trap).
