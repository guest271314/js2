---
id: 3500
title: "Carry checker type evidence into recursive linear IR call-graph closure"
status: ready
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: m
complexity: M
feasibility: hard
reasoning_effort: high
task_type: bug
area: ir, type-system, codegen-linear
goal: backend-agnostic-ir
depends_on: [3497]
related: [2956, 3498]
origin: "#3498 post-#3497 exact fib-recursive native-route probe"
---

# #3500 — Recursive call-graph type evidence

## Problem and evidence

After #3497 resolves the annotated `run(number): number` boundary in exact
`fib-recursive.js`, the unannotated internal recursive `fib` remains dynamic
and `run` closes with `select:call-graph-closure`. Guessing `f64` in the
benchmark or special-casing the function name would change source semantics.

## Implementation plan

1. Thread the compiler's existing checker-backed type evidence into linear IR
   selection/build using the shared integration contract.
2. Define conservative recursive fixed-point rules that claim a callee only
   when parameters, returns, and all recursive calls agree on supported types.
3. Keep unannotated/`any` functions dynamic when evidence is incomplete,
   conflicting, escaping, or used through unsupported higher-order paths.
4. Add positive exact-source recursion and negative polymorphic/dynamic cycles,
   then require the JS2→Porffor native oracle and clean sanitizers.

## Acceptance criteria

- Exact `fib-recursive.js` selects both functions without source annotations or
  benchmark-specific logic and returns Node-equal values through shared IR.
- Ambiguous recursive SCCs remain rejected with stable diagnostics.
- Selector, from-AST, WasmGC, linear, and Porffor tests remain green.
