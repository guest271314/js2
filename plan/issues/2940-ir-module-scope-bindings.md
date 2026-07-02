---
id: 2940
title: "IR: module-scope bindings referenced from function bodies"
status: blocked
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2856
depends_on: [2939]
related: [2855, 1376]
---

# #2940 — IR: module-scope bindings in function bodies

Child of #2856 (`body-shape-rejected` → 0), under the IR migration epic
#2855. **North star: route everything through the IR; backends are the only
fork.**

## Problem

`isPhase1Expr` (src/ir/select.ts) only accepts identifiers in the
function-local scope set (params/locals). References to **module-scope
bindings** reject as `expr:ident-not-in-scope`. Exact instances (from
`pnpm run check:ir-fallbacks -- --why`, #2856 instrumentation):

| function                                            | binding    | shape                              |
| ---------------------------------------------------- | ---------- | ----------------------------------- |
| `website/playground/examples/js/algorithms.ts::fibMemo` | `fibCache` | module-level cache (read + write)   |
| `website/playground/examples/dom/calendar.ts::renderCal` | `gridEl`  | module-level DOM handle             |
| `website/playground/examples/dom/calendar.ts::updFoot`   | `selStart` | module-level mutable state          |

3 of the 31 `body-shape-rejected` functions.

## Blocked on #2939 (contagion)

These functions' callers are the `main` drivers that are themselves demoted
on host globals. The selector's fixpoint loop (src/ir/select.ts ~415)
re-demotes any claimed function whose caller/callee is unclaimed
(`call-graph-closure`), so landing this slice before #2939 would only move
the 3 counts into `call-graph-closure` and FAIL the gate on that growth.
Flip to `ready` when #2939 merges.

## Direction

The legacy backend compiles module-scope `let`/`const` to Wasm globals (or
equivalent); the IR needs (a) a selector arm that recognises identifiers
bound at module scope (thread a module-scope binding set into
`planIrCompilation`'s shape walk), and (b) IR nodes/lowering for
module-global read and write that reuse the SAME global slots the legacy
backend allocates — the two front-ends coexist per function, so a module
global written by an IR function and read by a legacy function must be one
storage location. Mutable module state written from multiple functions is
the hazard: verify write-through semantics with an equivalence test that
mixes IR-claimed and legacy-compiled functions touching the same binding.

## Acceptance criteria

1. `body-shape-rejected` drops by 3 (the rows above); `call-graph-closure`
   does not grow; ratchet banks the decrease.
2. Equivalence parity: IR-claimed and legacy functions share the same module
   global storage (mixed read/write test).
3. `pnpm run check:ir-fallbacks` gate passes; no test262 regression.
