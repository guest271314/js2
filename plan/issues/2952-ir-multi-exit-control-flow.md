---
id: 2952
title: "IR multi-exit control flow: labeled break/continue, switch (br_table), do-while, for-in adoption"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: ir
language_feature: statements
goal: ir-full-coverage
related: [2949, 2135, 2134, 2856]
origin: "2026-07-02 July Fable audit §1 (all six '(future)' direct-only statement rows share one structural blocker)"
---

# #2952 — six direct-only statement kinds share one structural blocker

## Problem

`plan/log/ir-adoption.md` lists SwitchStatement, BreakStatement,
ContinueStatement, DoStatement, LabeledStatement, and ForInStatement as
direct-only with "(future)" tracking — i.e. no issue. The July audit found
the shared root cause: the IR's hybrid control flow (top-level blocks with
return/br/br_if/unreachable terminators, but if/try/loop as instructions
with **nested buffers** — `forEachNestedBuffer`, `src/ir/nodes.ts:2057`)
has **no br_table and no multi-level labeled exit**. A `break lbl` from two
nested buffers deep, or a switch dispatch, cannot be expressed, so these
kinds are structurally unadoptable regardless of bucket work. Every pass
also pays a double-traversal tax (blocks + nested buffers).

Note: current fallback-bucket counts do NOT measure this (zero body-shape
rejects contain these kinds on the ratchet corpus) — this is a test262-scale
adoption blocker, not a playground-bucket one.

## Approach

Two candidate designs — pick in an architect-spec slice first:

- **A (incremental): exit-label depth on nested-buffer nodes.** Give
  `IrInstrIf`/`IrInstrLoop`/`IrInstrTryCatch` an optional label id; add
  `IrInstrBrLabel {label, depth}` + `IrInstrBrTable`; verifier rule: label
  targets must lexically enclose. Lowering maps to Wasm block/br depths
  (WasmGC and linear identically — core Wasm both).
- **B (structural): true CFG for these kinds** — larger, interacts with
  #2134 (effect model) and the passes' double-traversal tax; only if A's
  verifier rules turn out unsound for finally-interaction.

Then adopt kinds in order of test weight: do-while (rewrites to while —
cheapest), labeled break/continue, switch (br_table over dense i32 keys,
if-chain otherwise), for-in last (needs `__object_keys` iteration — pairs
with #2964).

## Acceptance criteria

- Architect spec recorded here (A vs B decision + verifier rules).
- do/labeled/switch rows move direct-only → mixed/ir-owned in
  ir-adoption.md (regenerated); claim-row-backed-by-lowering tests per kind.
- No new demote channel usage: kinds are claimed only when fully lowerable
  (capability.ts rows, not select.ts predicates — #2135 discipline).
