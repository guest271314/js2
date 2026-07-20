---
id: 3501
title: "Infer typed linear vectors from empty-array write/read evidence"
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
area: ir, arrays, codegen-linear
goal: backend-agnostic-ir
depends_on: [3497]
related: [2956, 3498]
origin: "#3498 post-#3497 exact array-sum native-route probe"
---

# #3501 — Empty-array element inference

## Problem and evidence

Exact `array-sum.js` passes JSDoc signature selection after #3497 but demotes in
shared AST-to-IR building: `empty array literal needs a vec-typed hint to infer
element type`. The following indexed writes and reads provide numeric evidence,
but it is not propagated to the empty literal.

## Implementation plan

1. Reuse checker/type-map and local data-flow evidence to infer one supported
   vector element type for an empty literal before source-derived IR is built.
2. Require consistency across writes, reads, aliases, escapes, and control-flow
   joins; retain a stable rejection for mixed or unresolved element types.
3. Feed the inferred vector into the existing shared allocation registry and
   `LinearMemoryPlan`; do not synthesize source annotations or benchmark IR.
4. Add exact `array-sum.js` JS2→Porffor→C oracle/sanitizer coverage plus
   negative mixed-element and escaping-array tests.

## Acceptance criteria

- Exact `array-sum.js` reaches a source-derived numeric vector and Node-equal,
  sanitizer-clean native execution.
- No broad JavaScript array semantics are narrowed without proof.
- WasmGC and linear allocation/layout tests remain green.
