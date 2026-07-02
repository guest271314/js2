---
id: 2954
title: "LinearEmitter core-op coverage (const/binary/locals/control-flow/call) + cross-backend corpus dynamic rows"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen-linear
language_feature: compiler-internals
goal: backend-agnostic-ir
depends_on: [2953]
related: [1714, 1854, 2956, 1852]
origin: "2026-07-02 July Fable audit §5 (the '#1714 follow-up' is cited in five places but no issue exists)"
---

# #2954 — the linear emitter is a 3-method proof, not a backend

## Problem

`src/ir/backend/linear-emitter.ts` (215 lines) implements exactly three
vec-read primitives (#1714 proof); the other ~25 trait methods throw
`notImplemented` (:69-75). The bytecode emitter (#1715) has broader trait
coverage than linear does. Nothing can lower a whole function IR→linear,
so the production wiring (#2956) has no floor to stand on.

## Approach

1. Implement the pass-through families on LinearEmitter — const, binary,
   unary, locals/globals, if/br/br_if/block/loop, direct call. These emit
   core Wasm and are mostly **byte-identical to WasmGC's emission** (both
   backends share the `Instr` encoding) — cheap wins.
2. Extend `tests/ir-vec-two-backend.test.ts` to lower complete numeric /
   control-flow functions through BOTH emitters and execute both modules.
3. Extend `tests/cross-backend/corpus.ts` (#1854 harness, done) with the
   #1852-G5 dynamic-residue rows — typeof, truthiness, `===`, boxing
   round-trips — kept `expectLinearUnsupported` until #1852-G4/#2956 land,
   so the parity gap is measured, not silent.

## Acceptance criteria

- A recursive numeric fib + a loop/branch function lower through
  LinearEmitter and run correct in a linear-memory instantiation.
- notImplemented residue on LinearEmitter is only the genuinely
  representation-divergent families (aggregates, boxing, strings, closures)
  — each annotated with the covering issue id.
- Corpus G5 rows landed with expectLinearUnsupported markers.
