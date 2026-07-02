---
id: 2951
title: "IR-first skip set: include generators and class members (retire the two #2138 standing exclusions)"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, ir
language_feature: generators, classes
goal: ir-full-coverage
depends_on: [2138]
related: [2950, 1370, 2864]
origin: "2026-07-02 July Fable audit §1 (#2138 impl-note deviations 3 and 4 had no tracking issue)"
---

# #2951 — generators and class members always compile twice, even under IR-first

## Problem

#2138's landed skip-set computation (`computeIrFirstSkipSet`,
`src/codegen/index.ts:1139`) permanently excludes two families:

1. **Generators** — legacy generator compilation creates auxiliary
   machinery beyond the slot body; IR generator lowering registers its own
   imports (`addGeneratorImports`) but standalone-ness of the IR-only path
   without legacy's side effects is unproven (#2138 impl note, deviation 3).
2. **Class members** — the typeIdx parity contract with legacy callers
   (class-bodies.ts pre-allocated signatures, `integration.ts` parity
   guard) keeps them on the always-legacy-then-overwrite path (deviation 4).

Both exclusions are correct-but-untracked; #2950 (default flip) either
needs them retired or explicitly carved out.

## Approach

- **Generators:** enumerate the aux side effects of legacy generator
  compilation (imports, globals, helper funcs) vs what IR generator claim
  registers; either prove the IR path self-sufficient (then include
  IR-claimed generators in the skip set) or make the IR path register the
  missing pieces first. Probe: compile a claimed generator with the skip
  forced on and diff the module sections.
- **Class members:** carry the typeIdx-parity check into the skip decision
  — a member is skippable iff its IR signature byte-matches the
  class-bodies.ts pre-allocation (the parity guard already computes this;
  reuse, don't re-derive).

## Acceptance criteria

- `CompileResult.irFirstSkipped` lists generator and class-member bodies on
  a claim-dense probe.
- Flag-off byte-identity preserved; index-layout invariance test extended
  to a class+generator corpus.
- Full merge_group net-zero with the flag on (feeds the #2950 gate).
