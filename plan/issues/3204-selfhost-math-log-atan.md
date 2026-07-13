---
id: 3204
title: "Self-host Math.log + Math.log2 cores (bloat −LOC, scale-up slice)"
status: done
assignee: ttraenkler/opus-sendev
sprint: 71
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen, stdlib
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3141
related: [3090, 2855, 3159, 3160, 3161]
origin: "plan/self-hosting-scale-up.md slice 1 — math-helpers.ts remainder"
---

# #3204 — Self-host `Math.log` + `Math.log2` cores

Immediate-−LOC bloat-reduction slice (the pivot from the widen program, whose
skip-coverage ceiling is ~28% — see #3090). Converts two hand-emitted `Instr[]`
Math cores to ordinary TS source compiled through the compiler's own IR driver
(`stdlib-selfhost.ts`), following the #3141 pilot model.

## Scope (bounded, verified-clean)

`math-helpers.ts` slice-1 (scale-up plan) is the whole remainder
(sin/cos/exp/log/atan/tan/atan2/pow/log2/log10). I mapped gap-ops per kernel
empirically — the plan's "zero dialect gaps" is partly optimistic:

- **CLEAN (0 gap-ops, pure f64, convert now):** `log`, `log2`, `atan`,
  `atan2`, `sin/cos/tan`.
- **GAP-BLOCKED (stay hand-emitted):** `exp` (exponent-extraction bit ops),
  `pow` (i32 exp-by-squaring `shr_u`), `log10` (`f64.nearest` — deliberately
  NOT in `mathUnaryToIrOp`, select.ts:153 "unsound 1:1 lowering"), `random`
  (RNG import).

This PR does the two **`log` + `log2`** cores (highest-value: `log` is called by
pow/log10/asinh/acosh/atanh/log1p). `atan`/`atan2`/`sin`/`cos`/`tan` are a clean
follow-up; the dialect-intrinsics groundwork (f64.nearest, i32-local/shift,
reinterpret) unblocks exp/pow/log10 later.

## Implementation

- `src/stdlib/math.ts`: `LOG_SOURCE` / `LOG2_SOURCE` TS bodies (dialect subset)
  - `LOG_BUILTIN` / `LOG2_BUILTIN` exports.
- `src/codegen/math-helpers.ts`: replace the two hand `addMathFunc({...Instr[]})`
  blocks with inline `addedFuncs.set(name, emitSelfHostedMathFunc(ctx, BUILTIN))`
  at the **same early emission point** (both are called by later hand cores, so
  they cannot move to the late `SELF_HOSTED_MATH` leaf loop).

## Key finding (flagged for #2856)

from-ast mis-scopes the `let` declarations that FOLLOW a **non-returning mid-body
statement-if** into the if's then-branch (skipped when the branch is not taken).
The initial transcription hit this (`log(2.414)` returned `log(2)`); the fix
expresses the `if (f > sqrt2) {...}` adjust with ternary-initialized locals
(`over`/`ea`/`fa`) — bit-identical, stays in the decl-only tail subset. Same
class as #3203's `classify` "undefined SSA value" overlay bug.

## Validation

- tsc clean; net **−171 LOC** (85 added stdlib/math.ts, 256 deleted
  math-helpers.ts).
- **Bit-exactness: 2,851 comparisons vs a main-built control** (log/log2/log10/
  asinh/acosh/atanh/log1p/pow across a dense magnitude+fine sweep + specials) —
  **zero mismatches**.
- Math equivalence suites + merge_group (broad-ish; the standalone floor and
  merge-shard reports run there).

## Acceptance criteria

- `Math.log`/`Math.log2` (+ every dependent) bit-identical to the hand versions.
- Net −LOC; `math-helpers.ts` god-file shrinks.
- Green equivalence + merge_group.
