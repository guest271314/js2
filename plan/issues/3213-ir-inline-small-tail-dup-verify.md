---
id: 3213
title: "IR: inline-small tail-duplication trips post-inline verify (use of SSA value before def) for a call-result live across a duplicated if"
status: done
completed: 2026-07-13
assignee: ttraenkler/opus-2856
sprint: 71
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
related: [2856, 2977, 3203, 2138]
---

# #3213 — IR `inline-small` tail-dup trips post-inline verify

Split out of **#2856** (the from-ast overlay-bug work; PR #2977). This is a
**separate, deeper** bug from the one #2977 fixed (that was the emission-side
structurizer `materialized` leak in `lower.ts`). This one is in the
**`inline-small` pass** (`src/ir/passes/inline-small.ts`) + its post-inline
verify (`src/ir/integration.ts:478`), and is **pre-existing** (reproduces on
`origin/main` independent of #2977).

> (Originally drafted under id 3208, renumbered to 3213 — 3208 collided with an
> unrelated open PR #2979 `fix(#3208) reflective String` from another session.)

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

Verified **on base**: reverting #2977 does not change this — a distinct
pre-existing bug (see #2856's "Follow-up" note and PR #2977's body).

## Root-cause hypothesis (confirm with a measure-first probe)

Same structural CLASS as #2977 (block duplication + a value live across copies)
but in a different pass. When `inline-small` splices the callee body of `pred`
into `h` and/or rewrites the CFG around the tail-duplicated `if`, the def-block
bookkeeping for a value defined before the `if` and used in the duplicated
continuation is not preserved, so `verifyIrFunction`
(`src/ir/verify.ts` ~364 `dominatedCrossBlockDef` / ~406 use-before-def) sees
the def as missing (`defBlock.get(u) === undefined`) or same-block-but-later.
Likely either (a) the inliner duplicates the block but does not re-record the
def-block map / dominators for the value across the duplicate, or (b) the value
should be materialized / threaded but isn't. First step: dump the pre- and
post-`inlineSmall` IR (`integration.ts:469`) and diff the block/def structure vs
the un-inlined (pred-not-inlinable) control.

## Approach

1. Reproduce with the minimal case; dump pre/post-inline IR to see how the
   CFG/def-blocks differ from the un-inlined function.
2. Determine whether the fix belongs in `inline-small` (preserve def-block /
   re-thread the value) or is a verify-side dominator recomputation gap.
3. Fix with select↔build parity in mind (#2138): a wrong claim that verifies but
   traps under IR-first is worse than a demote — the verify catching it is the
   current safety net, so the fix must make the shape genuinely lowerable, not
   merely silence the verify.

## Acceptance criteria

1. The minimal repro (and the `const b = boolReturningCall(); if (b && …)` #3203
   shape) compiles through the IR path with correct output and IR-vs-legacy
   parity; the function is genuinely IR-owned (`irFirstSkipped` contains it).
2. No new `check:ir-fallbacks` growth; existing IR suites green.
3. A regression test (`tests/issue-3213-*.test.ts`) with anti-vacuity
   (byte-diff / `irFirstSkipped` assertion).

## Files

- `src/ir/passes/inline-small.ts` — the inliner's block/def handling.
- `src/ir/integration.ts` — post-inline verify wiring (~469-492).
- `src/ir/verify.ts` — dominance / use-before-def checks (~349-410) if the gap
  is verify-side.

## Resolution (2026-07-13, opus-2856)

**Root cause confirmed (not the hypothesis's "def-block bookkeeping" — simpler):**
`inlineIntoFunction` declared `callerRename` (the map `callSite.result →
inlinedReturnId`) **inside** the `for (const block of caller.blocks)` loop, so it
was reset every block. When an inlined call's result is a **cross-block** value
(`const b = pred(n); if (…){…b…}; …b…` — `b` defined in the entry block, used in
the then-block + continuation), the downstream uses were never repointed to the
inlined return id. `b` became an undefined SSA value → `verifyIrFunction` reported
"use of SSA value before def" → whole-function demote (IR-first hard error).

**Fix (1 line + comment):** hoist `callerRename` to **function scope** so a
call's rename reaches the blocks that consume its result. Safe because from-ast
emits reducible, forward-only CFGs (blocks visited in dominance order — a call's
rename is recorded before its consumer blocks are processed) and SSA ids are
globally unique (a rename only repoints its own def's uses). No new IR-node or
lowering work — the inlined value was always correct; only the caller-side
operand repointing was incomplete.

**Validation:** `tests/issue-3213-inline-small-crossblock.test.ts` (3 tests,
IR-vs-legacy parity + anti-vacuity `irFirstSkipped` assertions: cross-block use,
use-only-in-later-block, two cross-block results). tsc clean; IR suites green
(`ir-if-else`/`ir-let-const`/`ir-algorithms-cluster`/`issue-3203`/`issue-2952`;
`ir-scaffold`'s 2 failures are pre-existing container-env, verified on base);
`check:ir-fallbacks` OK (14→14, no delta — this unblocks correctness/IR-first
claims, it is not a bucket reducer); `check:loc-budget` OK (net +11).
