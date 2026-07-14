---
id: 3278
title: "Decompose compileArrowAsClosure — extract capture-analysis / struct-minting / destructuring / construction phases into named phase helpers"
status: in-progress
sprint: current
priority: high
feasibility: hard
model: opus
task_type: refactor
subtask_of: 3182
assignee: ttraenkler/Dev-WaveB-Closures
area: codegen
---

# Decompose `compileArrowAsClosure` (WAVE B)

## Scope

Behaviour-preserving **intra-function** decomposition of the ~1,311-LOC
god-function `compileArrowAsClosure` in `src/codegen/closures.ts` (the remaining
core after the wave-1 closures split). The function compiles a full
arrow / function-expression body as a first-class WasmGC closure and is a
natural PHASE sequence:

1. capture analysis (referenced / written free vars, outer-write boxing,
   TDZ-flag boxing) →
2. capture-struct type minting →
3. lifted-fctx build + capture-extraction prologue →
4. param destructuring + defaults →
5. lifted-fn body compilation (async / generator / block / concise) →
6. finalize + construction-site emit + closure-info registration.

The decomposition lifts cohesive phase blocks **verbatim** into named
module-private phase helpers in the same file, called at the same point with
the same arguments (operating on the shared `liftedFctx` / `fctx` objects by
reference), so the emitted bytes are IDENTICAL.

## Safety — prove-emit-identity

Every slice is gated by `scripts/prove-emit-identity.mjs`: golden baseline
(`write`) BEFORE the edits, `check` AFTER each phase extraction must print
IDENTICAL (39/39 gc/standalone/wasi). tsc 0. Any drift = the phase helper does
not reproduce the block's state threading → fix or revert.

## Slices

- **Slice 1** — `planClosureCaptures` (capture analysis, phase 1) +
  `mintClosureStructTypes` (capture-struct type minting, phase 2). Non-emitting
  analysis / type phases. ~370 LOC lifted.
- **Slice 2** — `emitClosureParamDestructuring` (phase 4 destructuring loop) +
  `emitClosureConstruction` (construction-site emit, phase 6) +
  `registerClosureBindingInfo` (closure-info registration, phase 6). The
  emission-heavy phases. ~330 LOC lifted.

## Implementation notes (WHY, not just WHAT)

- The function threads a **lot** of local state between phases. Phase boundaries
  were chosen where the shared state at the cut is minimal:
  - `planClosureCaptures(ctx, fctx, arrow, body) → { captures, selfBindingName }`.
    Its only side effect on the caller's `fctx` is seeding `fctx.tdzFlagLocals`
    (the #1177 block-scope-shadow rescan) — preserved because `fctx` is passed by
    reference. Everything else is fresh Sets it builds internally.
  - `mintClosureStructTypes(ctx, {...}) → { structTypeIdx, liftedFuncTypeIdx,
    liftedParams }`. `closureResults` and `isNamedFuncExpr` stay caller locals
    (both are read again downstream) and are passed in; `closureResults` is
    passed by reference and read-only inside the helper.
  - `emitClosureParamDestructuring` / `emitClosureConstruction` mutate
    `liftedFctx` / `fctx` (body, locals, boxedCaptures, boxedTdzFlags,
    tdzFlagLocals) by reference — a verbatim relocation of the emit statements,
    so field offsets and instruction order are byte-identical.
- Conservative: `compileArrowAsClosure` and its sibling `compileArrowAsCallback`
  share capture-analysis idioms, but they are NOT merged in this issue — the
  wave-A analysis flagged +0/+1 field-offset sensitivity in the shared emit, so
  a DRY-merge is out of scope unless prove-emit-identity stays IDENTICAL.

## Acceptance

- prove-emit-identity IDENTICAL (39/39) after every slice.
- tsc 0, `tests/issue-3278.test.ts` closure/arrow smoke test green.
- `compileArrowAsClosure` shrinks from ~1,311 LOC toward a thin phase-orchestrator.

## Test Results

(filled per slice)
