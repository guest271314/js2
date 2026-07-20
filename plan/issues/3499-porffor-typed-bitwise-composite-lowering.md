---
id: 3499
title: "Lower typed JS bitwise composites through the Porffor backend"
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
area: ir, porffor, lowering
goal: backend-agnostic-ir
depends_on: [3497]
related: [3288, 3498]
origin: "#3498 post-#3497 exact fib native-route probe"
---

# #3499 — Porffor typed bitwise composite lowering

## Problem and evidence

After #3497, exact `fib.js` selects `run` and produces typed SSA plus the shared
`LinearMemoryPlan`. Passing those exact artifacts to `lowerIrModuleToPorffor`
fails legality on two `js.bitor` instructions: the shared lowerer still expands
JS bitwise semantics with raw Wasm stack instructions, while the Porffor
backend correctly rejects `pushRaw`.

## Implementation plan

1. Express the existing ToInt32/bitwise/signed-or-unsigned-convert-back sequence
   through typed backend-emitter operations or a backend-neutral composite-op
   lowering pass; do not add raw C, benchmark-name cases, or a Porffor-only IR.
2. Preserve mixed `i32`/`f64`, narrowed `i32` chains, `>>>` unsigned results,
   local scratch ordering, and WasmGC byte/stack behavior.
3. Admit `js.bitand`/`js.bitor`/`js.bitxor`/shift ops in Porffor legality only
   after every shape has a typed implementation.
4. Add emitter/legality tests and an exact-source `fib.js` JS2→Porffor→C native
   oracle plus clean ASan/UBSan coverage.

## Acceptance criteria

- Exact `fib.js` reaches clean native execution through source-derived JS2 IR
  and the shared memory plan without source substitution or raw Wasm escape.
- JS ToInt32 and signed/unsigned result semantics match Node on boundary inputs.
- Existing WasmGC, bytecode, stack-balance, and Porffor legality tests remain
  green.
