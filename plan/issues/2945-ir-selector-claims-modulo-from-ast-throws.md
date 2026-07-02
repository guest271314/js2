---
id: 2945
title: "IR selector claims `%` (modulo) but from-ast throws — post-claim drift surfaced by JS2WASM_IR_FIRST"
status: ready
sprint: Backlog
created: 2026-07-02
updated: 2026-07-02
priority: medium
feasibility: medium
horizon: s
task_type: bug
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2135, 2138, 1131]
origin: "2026-07-02 #2138 IR-first flag-on divergence sweep (dev-2138f)"
---

# IR selector claims `%` but `from-ast.ts` throws "operator '%' not in slice 11"

## Problem

Live selector↔builder capability drift (the exact class #2135 exists to
retire), surfaced as the first divergence by #2138's `JS2WASM_IR_FIRST=1`
investigation flag:

```ts
export function m(a: number, b: number): number {
  return a % b;
}
```

- `src/ir/select.ts` (`isPhase1Expr`) **accepts** the `%` BinaryExpression, so
  the selector claims `m`.
- `src/ir/from-ast.ts` **throws** `ir/from-ast: operator '%' not in slice 11 (m)`
  at build time.
- Flag OFF (today's default): the failure demotes to a warning and the legacy
  body ships — a silent compile-twice fallback, counted only on the
  `irPostClaimErrors` channel (kind `build`).
- Flag ON: the legacy body was skipped, so the failure is a HARD compile
  error tagged `[IR-FIRST skipped-slot, #2138]` (fail-loud contract).

`plan/log/ir-adoption.md` documents `%`/`**`/`in`/`instanceof` as throwing in
from-ast (BinaryExpression row, "mixed") — but the selector side does not
reject them, which is the drift.

## Fix options (either closes the drift)

1. **Selector-side (cheap, conservative)**: reject `%` (and audit `**`, `in`,
   `instanceof` — same row) in `isPhase1Expr` so the claim never happens.
   Bucket: `body-shape-rejected`.
2. **Builder-side (better)**: lower `%` in the IR. JS `%` on f64 is
   `a - b * trunc(a / b)` (C-style fmod semantics, sign of dividend — NOT
   `f64.rem` which Wasm lacks anyway); i32 lane can use `i32.rem_s` ONLY
   under a proven-no-negative/zero refinement, else the f64 formula.
   Follows the existing IrBinop extension pattern.

Option 2 is preferred iff the legacy lowering of `%` is confirmed
semantics-identical (compare against `src/codegen/expressions.ts`'s modulo
emission); otherwise land 1 first and track 2 under #1131.

## Acceptance criteria

- `tests/issue-2138.test.ts`'s trap test flips through its `driftLives ===
  false` branch (the fixture no longer traps flag-on), and stays green.
- No `irPostClaimErrors` entry with `operator '%'` on the corpus
  (`pnpm run check:ir-fallbacks` post-claim table).
- Flag-on compile of the repro succeeds with identical runtime results to
  flag-off (including negative/fractional operands: `-7 % 2`, `7.5 % 2`,
  `x % 0` → NaN).

## Notes

Found via #2138 Slice-2 probes (see `## Measurement (JS2WASM_IR_FIRST)` in
`plan/issues/2138-ir-first-compile-once-inversion.md`). The 233-file corpus
sweep found no OTHER flag-on-only failures — this is the sole divergence
surfaced so far; the Slice-3 full test262 run may add more.
