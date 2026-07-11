---
id: 3143
title: "Flip IR-first (JS2WASM_IR_FIRST) to default — clears gate G1 of the legacy-frontend retirement"
status: done
sprint: current
assignee: ttraenkler/fable-shrink
created: 2026-07-11
updated: 2026-07-11
completed: 2026-07-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
depends_on: [2856]
related: [2138, 3090, 2855]
origin: "plan/bloat-reduction-battle-plan.md slice 4; gate G1 in plan/log/3090-phase0-legacy-delete-list.md"
---

# #3143 — Make IR-first compilation the default (gate G1)

## Problem

Today the IR is an **overlay**: legacy compiles every function first, then IR-compiled
bodies replace legacy bodies (`src/codegen/index.ts` overlay block ~:2096). #2138
(done) built the inversion behind `JS2WASM_IR_FIRST=1` — legacy emission is skipped
for claimed functions — but it is **not the default**. Gate **G1** in
`plan/log/3090-phase0-legacy-delete-list.md`: *no live legacy handler can be deleted
until IR-first is the default*, because the overlay keeps every handler reachable.

## Implementation Plan (architect)

1. **Precondition**: #2856 (`body-shape-rejected` → 0) landed — the last unintended
   fallback bucket; flipping earlier just widens the population where IR-first vs
   overlay can diverge.
2. **Flip**: default the IR-first path on in `src/codegen/index.ts` (keep
   `JS2WASM_IR_FIRST=0` as an escape hatch for one release); keep the demote-to-legacy
   fallback for *rejected* functions unchanged.
3. **Measure**: full-corpus A/B on CI sharded test262 (host + standalone lanes) —
   net ≥ 0, no async/generator bucket regression. This changes which emitter produced
   every claimed function's bytes; it is NOT byte-inert — the merge_group standalone
   floor is the hard gate.
4. **Bank**: promote the zeroed rejection reasons into `STRICT_IR_REASONS`
   (`src/codegen/index.ts`) per the #2855 ratchet so regressions become hard errors.

## Acceptance criteria

- IR-first is the default compile mode; overlay path behind the escape-hatch env only.
- test262 net ≥ 0 on merge_group; ir-fallback baseline unchanged or lower.
- `plan/log/3090-phase0-legacy-delete-list.md` G1 marked cleared (unblocks Phase 3a).

## Implementation notes (2026-07-11, fable-shrink)

- Gate line (`src/codegen/index.ts` ~:2100): `!explicitlyDisabledEnv(JS2WASM_IR_FIRST)`
  — default ON under `experimentalIR`; only explicit `0`/`false` disables
  (one-release escape hatch). `disableIrFirst` (#2973 eval/new-Function
  sub-compiles) unchanged.
- **New gate 7** (`irFirstBodyHasNullish`, `src/codegen/ir-first-gate.ts`):
  functions containing `??`/`??=` stay compile-twice. `lowerNullish` covers
  only reference-shaped operand pairs; without the gate the flip promoted the
  documented metered `??` residual demote (#2135) to a skipped-slot hard
  compile error (caught by `tests/issue-2135.test.ts` pre-PR). Retire the
  gate when `lowerNullish` covers all operand shapes.
- Off-arm test/sweep stubs switched from unset/`""` to explicit `"0"`
  (issue-2138/2951/2945/2972, `scripts/ir-first-sweep.mts`).
- Coordinated with fable-irflip: buckets = body-shape-rejected 15 (never
  claimed → out of the A/B population), post-claim demotions 0; no file
  conflict (they work in `src/ir/*`).
- STRICT_IR_REASONS banking (plan step 4) deliberately deferred to a
  follow-up PR so the flip's A/B stays clean.
- The `test262-sharded.yml` `ir_first` dispatch input is now vestigial
  (its `'1'` equals the default); repurpose to `'0'` later if a legacy-lane
  measurement is ever needed.
