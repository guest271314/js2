---
id: 3502
title: "Lower landing string construction and char methods through shared IR"
status: ready
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, strings, codegen-linear, porffor
goal: backend-agnostic-ir
depends_on: [3497]
related: [2956, 3498]
origin: "#3498 post-#3497 exact string-hash native-route probe"
---

# #3502 — Shared string build and character methods

## Problem and evidence

Exact `string-hash.js` passes JSDoc signature selection after #3497, then shared
IR building rejects string compound assignment as a non-`f64` slot. The direct
linear fallback also reports unsupported `.charAt()` and `.charCodeAt()`.
These are representation/lowering gaps, not benchmark support cells.

## Implementation plan

1. Define backend-neutral typed IR operations for the required string append,
   `String.fromCharCode`, `charAt`, and `charCodeAt` semantics, including bounds
   and UTF-16 code-unit behavior.
2. Connect them to the existing linear string layout/runtime operations and the
   shared `LinearMemoryPlan`, then add typed Porffor emitter mappings without
   raw C or static vendor imports.
3. Preserve WasmGC/native-string behavior and reject unsupported coercive or
   prototype-dynamic cases before claim.
4. Add boundary Unicode/out-of-range tests and exact `string-hash.js`
   JS2→Porffor→C oracle plus clean ASan/UBSan coverage.

## Acceptance criteria

- Exact `string-hash.js` reaches Node-equal, sanitizer-clean native execution
  from shared source-derived IR with no source rewrite.
- UTF-16 and out-of-range behavior is explicit and backend-consistent.
- Existing string, linear-memory, WasmGC, and Porffor tests remain green.
