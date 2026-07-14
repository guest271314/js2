---
id: 3259
title: "Bloat quick-wins: knip dead-export sweep + jscpd duplication scan of src/codegen"
status: ready
sprint: current
priority: high
horizon: s
feasibility: easy
task_type: chore
area: codegen, ci
goal: ir-full-coverage
created: 2026-07-14
related: [3090, 3256]
origin: "sprint-71 bloat audit — automated dead-code + duplication before the self-host epic"
---

# #3259 — Bloat quick-wins: knip + jscpd

## Problem

Before the multi-window self-host epic (#3256–#3258), two cheap automated
passes bank easy −LOC and inform the self-host order.

## Scope

1. **knip dead-export sweep.** `knip` is already wired into quality CI (#3090
   Phase 2b, banked −1,800 LOC). Re-run it (`pnpm run knip` or the wired check),
   delete confirmed dead exports/files, gated by the existing knip config. Land as
   a single deletion PR (merge_group A/B validates zero behavior change).
2. **jscpd copy-paste scan of `src/codegen/`.** Run jscpd over `src/codegen/`
   (the hand-emission families likely share large duplicated `Instr[]`
   sequences). Report the top duplicated blocks. Where a duplicated Instr-sequence
   is a clear helper-extraction, extract it (net −LOC, byte-inert). Where it's an
   artifact of hand-emission that self-hosting will delete anyway, just note it in
   `plan/self-hosting-scale-up.md` to sequence #3256–#3258.

## Acceptance

- knip dead-exports deleted (net −LOC), quality CI green.
- jscpd top-duplication report committed to `plan/log/`; any clean helper
  extractions landed byte-inert.

## Non-goals

- No risky god-file restructuring (calls.ts/index.ts shrink is a byproduct of the
  IR migration #2855 + backend convergence #2953/#2956, not direct editing).
