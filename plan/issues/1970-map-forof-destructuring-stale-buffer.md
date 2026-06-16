---
id: 1970
title: "for (const [k,v] of map) yields the FIRST entry on every iteration — stale destructuring conversion buffer not reset per iteration"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: critical
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring
goal: iterator-protocol
related: [1258, 1146, 859, 1847, 2065]
origin: "2026-06-10 deep-audit sweep (objects agent): verified miscompile on main, WAT-proofed"
---

# #1970 — destructure-in-loop reuses iteration 1's materialized vec

## Problem

The canonical Map iteration idiom yields the first entry forever:

```ts
const m=new Map(); m.set("a",1); m.set("b",2);
let r=""; for (const [k,v] of m) r+=k+"="+v+";"; return r;
```

wasm: `"a=1;a=1;"` — node: `"a=1;b=2;"`. Iteration *count* is right; values
are stale. Same for the body form (`const [k,v] = e as any`). Non-destructured
access (`e[0]`, `e[1]`) is correct.

## Root cause

`destructureParamArray`'s externref branch
(`src/codegen/destructuring-params.ts:891`) allocates `resultLocal`
(`__dparam_cvt_*`); the materialization fallbacks at :1195-1203 and
:1217-1229 are gated on `local.get resultLocal; ref.is_null` ("only run
fallback if still null"). The local is **never reset to null at the start of
the emitted sequence**, so inside a loop (for-of-over-Map head lowers through
`compileForOfIterator` → `compileExternrefArrayDestructuringDecl` → this
helper, executed per iteration) iteration 2 finds iteration 1's vec non-null,
skips re-materializing, and destructures the stale vec. WAT confirms
(`$__dparam_cvt_14` only written inside the gated branches). Host JS arrays
(Map entries, any host-returned array) are exactly the values that reach this
fallback.

## Fix direction

Emit `ref.null <extVecIdx>; local.set resultLocal` (and reset any other
branch-written state the gates read) at the top of the externref destructure
sequence, making the emitted code idempotent under re-execution.

## Acceptance criteria

- Repro matches Node; 3+ entries correct
- `for (const [a,b] of hostArrayOfPairs)` correct
- Object-pattern equivalents checked for the same gate pattern
- Single-execution destructuring unregressed

## Dupe check

#1258 (boxedCaptures routing), #1146 (rest patterns), #859 (Map.forEach
snapshots), #1847 (localMap rollback) — all done, none cover this. Unfiled.

## Resolution (2026-06-12)

Fixed exactly per the fix direction: `destructureParamArray`'s externref
branch now emits `ref.null <extVecIdx>; local.set resultLocal` at the top of
the emitted sequence (`src/codegen/destructuring-params.ts`, right after the
`resultLocal` alloc), so the `ref.is_null`-gated materialization fallbacks
re-run on every execution. Audited the other gates in the same emitted
sequence: `dstrDoneLocal` was already reset to 0 per execution, `anyTmp` is
written unconditionally, and the object-pattern paths (`__dparam_cvt_` at
:627, `destructureParamObjectExternref`) write their buffers unconditionally
before use — no other stale-gate instances.

## Test Results

- Repro: `for (const [k,v] of m)` with 3 entries — wasm `"a=1;b=2;c=3;"`
  matches Node (was `"a=1;a=1;a=1;"`).
- `tests/issue-1970.test.ts` — 6/6 pass: for-of head form, body form
  (`const [k,v] = e as any`), `Object.entries` pairs, defaults in loop,
  single-execution param destructuring, repeated destructuring calls.
- Related suites: `tests/iterators.test.ts` 6/6,
  `tests/issue-1372-ir-destructuring-params.test.ts` 10/10,
  `tests/equivalence/destructuring-initializer.test.ts` 7/7 pass.
- `tests/map-set.test.ts` (3 fails) and `tests/null-destructure-param-object.test.ts`
  (3 fails) fail identically on main — pre-existing, unrelated.
  `tests/basic-destructuring.test.ts` / `tests/array-rest-destructuring.test.ts` /
  `tests/for-of-array-destructuring.test.ts` / `tests/map-set-basic.test.ts` /
  `tests/null-destructuring.test.ts` / `tests/destructuring-member-targets.test.ts`
  fail at import on main too (missing `tests/helpers.js`) — pre-existing.
