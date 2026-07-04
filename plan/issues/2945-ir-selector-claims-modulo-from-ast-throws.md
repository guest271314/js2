---
id: 2945
title: "IR selector claims `%` (modulo) but from-ast throws — post-claim drift surfaced by JS2WASM_IR_FIRST"
status: done
completed: 2026-07-02
assignee: ttraenkler/dev-2138f
sprint: 69
created: 2026-07-02
updated: 2026-07-03
priority: medium
feasibility: medium
horizon: s
task_type: bug
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2135, 2138, 1131, 2056]
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

## Resolution (dev-2138f, 2026-07-02) — option 2 implemented (builder-side lowering)

Two-stage close:

1. **#2135 slice 1** first retired the hard-error mode: `%` flipped to
   capability `defer` (selector rejects → legacy), so the IR-first trap
   became structurally impossible. The Slice-3 full flagged run confirmed
   zero `%`-class failures.
2. **This PR** implements the lowering and flips the row `defer → "claim"`:
   `lowerBinary`'s `PercentToken` arm emits
   `emitCall({kind:"func", name: FMOD_FN}, [lhs, rhs], f64)` — a call to the
   **same Wasm-native exact-remainder helper `__fmod` (#2056) that legacy's
   `emitModulo` emits**, so IR and legacy agree bit-for-bit. The integration
   resolver (`makeResolver.resolveFunc`) materializes the helper on demand
   (`ensureFmod` — idempotent, appends a defined function, never an import,
   so no funcIdx shifts).

**Correction of this issue's own fix sketch (verify-first, the #2945
lesson):** the `a - b * trunc(a / b)` formula suggested above is WRONG — it
is not IEEE fmod (ULP drift; collapses for large quotients; `a/b` overflow
→ ±Inf; `1e308 % 1e-308` breaks). Legacy tried exactly that and replaced it
with `__fmod` (see `src/codegen/fmod.ts` #2056 notes). Never re-derive `%`
inline; call the helper.

Scope notes:
- **f64 operands only** — i32-typed operands demote to legacy via the
  type-resolution lane (`requireF64`); legacy's i32 fast mode keeps its
  trap-free `emitSafeI32Rem`. An IR i32 `%` (needs a nonzero-divisor /
  non-INT_MIN proof, and `x % 0` → NaN has no i32 representation) is
  deliberately out of scope.
- Call-graph win: pre-fix, a `%`-containing helper dragged its CALLERS off
  the IR path too (bidirectional closure); now the whole closure stays
  claimed (`tests/issue-2945.test.ts` pins this).

Acceptance verified: `tests/issue-2945.test.ts` — capability row + selector
claim; 16-case bit-exact parity vs JS (`Object.is`, incl. `-0`, `x % 0` →
NaN, `±Inf`, NaN propagation, `1e308 % 1e-308`, ULP-drift case) flag-off AND
under `JS2WASM_IR_FIRST=1` (legacy body skipped, `irFirstSkipped` contains
the function); `tests/issue-2135.test.ts` updated (`%` moved to the claimed
side; table sanity row → "claim"); post-claim demotions "(none)" on the
corpus; fallback baseline refreshed (the slice-1 ±2 relabel reverses: the
two corpus functions' real blocker is a call edge, `%` was just the
earlier-checked rejection reason — totals unchanged).
