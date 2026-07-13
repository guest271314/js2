---
id: 3208
title: "IR: inline-small tail-duplication trips post-inline verify (use of SSA value before def) for a call-result live across a duplicated if"
status: ready
sprint: current
created: 2026-07-13
updated: 2026-07-13
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [2856, 3203, 2138]
---

# #3208 — IR `inline-small` tail-dup trips post-inline verify

Split out of **#2856** (the from-ast overlay-bug work). This is a **separate,
deeper** bug from the one #2977 fixed (that was the emission-side structurizer
`materialized` leak). This one is in the **`inline-small` pass** (`src/ir/passes/
inline-small.ts`) + its post-inline verify (`src/ir/integration.ts:478`), and is
**pre-existing** (reproduces on `origin/main` independent of #2977).

## Symptom

The #3203 shape — a `const b = <call>(); if (b …) …; use b more than once` — a
call-result SSA value that is **live across a mid-body `if`** (which the
structurizer tail-duplicates) — fails the post-inline verify as a hard IR-first
error instead of compiling:

```
Codegen error: IR path failed for h: post-inline verify: use of SSA value 1
before def in block 1 [IR-FALLBACK] [IR-FIRST skipped-slot, #2138]
```

## Minimal repro (fails on main; `experimentalIR: true`)

```ts
function pred(n: number): number { return n * 2 + 1; }
export function h(n: number): number {
  const b: number = pred(n);         // SSA value, inlined by inline-small
  let r: number = 0;
  if (b > 10) { r = b; }             // non-terminating mid-body if (tail-dup'd)
  let s: number = r * r + b * b;     // b live AFTER the if, used again
  return s;
}
```

`h` fails post-inline verify with "use of SSA value 1 before def in block 1/2".
Value `1` is `b = pred(n)`, defined in block 0, used in block 1 (then: `r = b`)
and block 2 (`b*b`). Removing the `if`, or making `pred` non-inlinable, makes it
compile — so it is the **inline-small pass's handling of a value live across the
tail-duplicated `if`** that breaks the def/use dominance the verifier checks.

Verified **on base**: reverting #2977 does not change this — it is a distinct
pre-existing bug (see #2856's "Follow-up" note).

## Root-cause hypothesis (confirm)

Same structural CLASS as #2977 (block duplication + a value live across copies)
but in a different pass. When `inline-small` splices a callee body in and/or
rewrites the CFG around the tail-duplicated `if`, the def-block bookkeeping for a
value defined before the `if` and used in the duplicated continuation is not
preserved, so `verifyIrFunction` (`src/ir/verify.ts` ~364 `dominatedCrossBlockDef`
/ ~406 use-before-def) sees the def as missing or same-block-but-later. Likely
either (a) the inliner duplicates the block but does not re-record the def-block
map / dominators for the value across the duplicate, or (b) the value should be
materialized/threaded as a block arg but isn't.

## Approach

1. Reproduce with the minimal case above; dump the pre- and post-inline IR
   (`lowerFunctionAstToIr` + the `inlineSmall` step in `integration.ts:469`) to
   see exactly how the CFG/def-blocks differ from the un-inlined function.
2. Determine whether the fix belongs in `inline-small` (preserve def-block /
   re-thread the value) or is a verify-side dominator recomputation gap.
3. Fix with select↔build parity in mind (#2138): a wrong claim that verifies but
   traps under IR-first is worse than a demote — the verify catching it is
   currently the safety net, so the fix must make the shape genuinely lowerable,
   not merely silence the verify.

## Acceptance criteria

1. The minimal repro (and the `const b = boolReturningCall(); if (b && …)` #3203
   shape) compiles through the IR path with correct output and IR-vs-legacy
   parity; the function is genuinely IR-owned (`irFirstSkipped` contains it).
2. No new `check:ir-fallbacks` growth; existing IR suites green.
3. A regression test (`tests/issue-3208-*.test.ts`) with anti-vacuity
   (byte-diff / `irFirstSkipped` assertion).

## Files

- `src/ir/passes/inline-small.ts` — the inliner's block/def handling.
- `src/ir/integration.ts` — post-inline verify wiring (~469-492).
- `src/ir/verify.ts` — dominance / use-before-def checks (~349-410) if the gap
  is verify-side.
