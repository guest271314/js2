---
id: 3143
title: "Flip IR-first (JS2WASM_IR_FIRST) to default — clears gate G1 of the legacy-frontend retirement"
status: ready
sprint: Backlog
created: 2026-07-11
updated: 2026-07-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
depends_on: [3167, 3168]
related: [2138, 3090, 2855, 2856, 3153, 3156]
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

## Implementation Plan (architect — re-sequenced 2026-07-12 audit)

> **Audit note (2026-07-12, verified @ upstream/main adc65cfc65):** the
> original precondition on #2856 was too strong. Under IR-first, selector
> REJECTS (body-shape-rejected etc.) are **never in the skip set**
> (`computeIrFirstSkipSet` only skips CLAIMED functions) — they keep their
> legacy bodies and demote safely pre-claim. The only hard-error population
> is **post-claim throws** (claimed + skipped, then from-ast/lower throws —
> "never a silent legacy demote", codegen/index.ts:2147–2172). So the true
> flip gate is **zero post-claim demotions on the corpora**, measured by the
> #3153 meter. #2856 (blocked epic, 14 residual body-shape rejects — all
> playground capability programs) is decoupled: it gates legacy *deletion
> breadth*, not the flip itself.

1. **Preconditions (the #3153 census classes, in place of #2856):**
   - #3156 substring/charCodeAt family — **done** (2026-07-12).
   - #3167 string relational operators — lowerable + selector mirror.
   - #3168 unary `+`/`-` ToNumber — lowerable + selector mirror.
   - TypedArray-view element store (census class 4): do NOT lower; add a
     **selector mirror** so bodies containing an element store to a
     TypedArray view reject pre-claim (small predicate in
     `src/ir/select.ts`/`capability.ts` mirroring the from-ast throw
     condition — the #2856-C2 documented residual). This is part of THIS
     issue's flip PR.
   - **Gate check**: `JS2WASM_IR_POSTCLAIM_LOG=<f>` over a full
     `tests/equivalence` run + `STRIDE=300 npx tsx scripts/ir-postclaim-meter.mts .`
     both report **zero** post-claim demotions.
2. **Flip**: default the IR-first path on in `src/codegen/index.ts` (keep
   `JS2WASM_IR_FIRST=0` as an escape hatch for one release); keep the demote-to-legacy
   fallback for *rejected* functions unchanged.
3. **Measure**: full-corpus A/B on CI sharded test262 (host + standalone lanes) —
   net ≥ 0, no async/generator bucket regression. This changes which emitter produced
   every claimed function's bytes; it is NOT byte-inert — the merge_group standalone
   floor is the hard gate. (Standalone/WASI keep generators compile-twice —
   `computeIrFirstSkipSet` gate 2 — so the #3164/#3132 generator work is
   orthogonal to this flip.)
4. **Bank**: promote the zeroed rejection reasons into `STRICT_IR_REASONS`
   (`src/codegen/index.ts`) per the #2855 ratchet so regressions become hard errors.

**Payoff**: clears gate G1 → unlocks the ~60.0K legacy-only fn-lines in
`plan/log/3090-phase0-legacy-delete-list.md` (Phase 3a deletion).

## Acceptance criteria

- IR-first is the default compile mode; overlay path behind the escape-hatch env only.
- test262 net ≥ 0 on merge_group; ir-fallback baseline unchanged or lower.
- `plan/log/3090-phase0-legacy-delete-list.md` G1 marked cleared (unblocks Phase 3a).
