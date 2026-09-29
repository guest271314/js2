---
id: 6759
title: "perf(codegen): the post-codegen repair passes walk every function body and cost ~31 % of a standalone test262 compile"
status: in-progress
sprint: current
priority: high
horizon: m
goal: maintainability
reasoning_effort: max
assignee: ttraenkler/opus-standalone-repair-passes
requested_by: ttraenkler/opus-lead
created: 2026-09-29
related: [6480, 6722, 6723, 2710]
# 2026-09-29 (#6759): stack-balance.ts grows by the opcode-delta cache, the
# lazily compared branch contexts and the per-function tree flag (+58 lines);
# ir-inline.ts by the fused call-graph/hotness helper, the fused callee-facts
# walk and the specialisation-size memo (1500 -> ~1572). Both are pass-local
# fast paths whose invariants live next to the code they skip.
loc-budget-allow:
  - src/codegen/stack-balance.ts
  - src/codegen/ir-inline.ts
# 2026-09-29 (#6759): computeInstrDelta is the former instrDelta ladder
# (318 lines on main, unchanged in length) renamed behind a cached wrapper.
func-budget-allow:
  - src/codegen/stack-balance.ts::computeInstrDelta
---

## Problem

Standalone test262 compiles are the long pole of every merge group (#6722):
median 2.25 s per row, 38.8 core-hours per full corpus. The linked-harness route
to cut that (#6723) failed its P2 gate (10,401 pass→fail, ≤1.4× at best), so the
remaining lever is the standalone compile itself.

## Measurement (2026-09-29)

`node --cpu-prof --import tsx` over 40 warm in-process standalone compiles of a
seeded random sample of passing non-Temporal rows (`random.seed(7)` over the
promoted standalone baseline; honest whole-assembly source via
`assembleOriginalHarness(...).primary`), `target: "standalone"`. 64.0 s for 40
compiles (1.6 s each). Main-thread profile, inclusive time:

| function | share |
|---|---:|
| `generateModule` (all codegen) | 81.9 % |
| `stackBalance` (`src/codegen/stack-balance.ts`) | 9.3 % |
| `inlineUserFunctions` (`src/codegen/ir-inline.ts`) | 8.8 % |
| `fixupExternConvertAny` (`src/codegen/fixups.ts`) | 6.6 % |
| `repairCrossHierarchyOperands` (`src/codegen/cross-hierarchy-operands.ts`) | 6.6 % |
| garbage collector (self) | 8.1 % |

Self time by file: stack-balance 9.5 %, ir-inline 8.7 %, fixups 8.1 %,
call-arg-producers 4.4 %, cross-hierarchy-operands 3.7 %, instruction-walk 2.6 %.

The four passes are whole-module: each re-walks every function body after
codegen, including the large standalone runtime helpers the module links in,
which are the same on every compile.

## Implementation Plan

Goal: cut the cost of these passes on standalone compiles with **byte-identical
output**. No verdict may change, so no test262 re-baseline is needed.

1. Instrument first: per pass, how many bodies are walked, how many are actually
   changed, and how much of the walked instruction count belongs to runtime /
   helper bodies versus user bodies. That decides the lever.
2. Candidate levers, in order of expected payoff:
   - **Skip bodies that cannot need repair**: a body emitted by a helper
     generator that is already stack-balanced and typed can be marked clean at
     emission, and each pass skips clean bodies. The bit must be conservative:
     any later mutation of a body clears it.
   - **Fuse traversals**: passes that each walk every instruction array
     (`walkInstructionArrays`, `forEachInstr`, `crossFunctionBodies`) can share
     one traversal where their order constraints allow. Document every ordering
     constraint before fusing.
   - **Cut allocation**: `cloneInstr` and per-walk arrays drive the 8 % GC.
3. Keep each lever as its own commit with its own measurement.

## Acceptance

- Output byte-identical: sha256 of every `.wasm` equal before and after on a
  ≥ 200-row standalone sample, a ≥ 200-row host sample, and
  `node scripts/equivalence-gate.mjs` with no new regressions.
- Standalone compile time on the same 40-row sample reduced by ≥ 20 %, measured
  with three interleaved rounds per variant (noise is ±10 %).
- Full CLAUDE.md gate chain green.
