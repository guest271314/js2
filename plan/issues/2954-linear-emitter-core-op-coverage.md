---
id: 2954
title: "LinearEmitter core-op coverage (const/binary/locals/control-flow/call) + cross-backend corpus dynamic rows"
status: done
completed: 2026-07-02
assignee: ttraenkler/opus-dev-a
sprint: 69
created: 2026-07-02
updated: 2026-07-03
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

## Resolution (2026-07-02)

Implemented in `src/ir/backend/linear-emitter.ts` + `src/ir/backend/legality.ts`.

1. **LinearEmitter core-op families** — `emitConst` (delegates to the shared
   `emitConstInstr`, numeric/bool), `emitBinary`/`emitUnary`, locals
   (`emitLocalGet/Set/Tee`), globals (`emitGlobalGet/Set`), `emitDrop`/
   `emitSelect`/`emitReturn`/`emitUnreachable`, structured control flow
   (`emitIf`/`emitBr`/`emitBrIf`/`emitBlock`/`emitLoop`), and `emitCall`
   (direct). Each is a literal 1:1 copy of `WasmGcEmitter`'s method — these
   emit CORE Wasm and both backends share the `Instr` encoding, so the streams
   are byte-identical by construction (pinned method-by-method in
   `tests/ir-vec-two-backend.test.ts`).
2. **notImplemented residue** is now only the representation-divergent
   families, each annotated with the covering issue: `emitVecNewFixed` (#1804),
   `emitCallRef`/aggregates/ref-cells/exceptions (#2956/#2953). Boxing/strings/
   closures are routed through the resolver in lower.ts, not this emitter.
3. **Legality gate** — `verifyIrBackendLegality`'s `linear` branch previously
   rejected EVERY instruction (blocking whole-function lowering); it now uses a
   `linearInstrError` allow-list (const/binary/unary/select/if/call/globals/
   slots/while.loop/for.loop) mirroring `bytecodeInstrError`. Divergent kinds
   (object/closure/box/string/refcell/…) stay rejected; the operand-type gate
   independently rejects non-{i32,i64,f32,f64} operands.
4. **Execution proof** — a recursive numeric `fib` and a `for`-loop/branch
   `sumTo` (ternary in the body) are lowered from real frontend IR through
   `LinearEmitter`, assembled into a linear-memory module (`emitBinary`),
   instantiated, and executed with correct results; the same IR through
   `WasmGcEmitter` yields a byte-identical body.
5. **Corpus G5 rows** — `dynamic/typeof-residue`, `dynamic/truthiness`,
   `dynamic/strict-eq-boxed`, `dynamic/box-roundtrip` added to
   `tests/cross-backend/corpus.ts`, all `expectLinearUnsupported` (WasmGC
   compiles+runs; linear fails to compile/instantiate — gap measured, ratchets
   when #1852-G4/#2956 land).

### Test Results

- `tests/ir-vec-two-backend.test.ts` — 14 pass (existing #1714 vec-divergence +
  new #2954 core-op byte-identity + fib/sumTo execution).
- `tests/cross-backend-diff.test.ts` — 29 pass (incl. 4 new dynamic G5 rows).
- `tests/issue-1850.test.ts` — 11 pass (legality gate re-scoped for #2954).
- `tests/ir-bytecode-proof.test.ts` — unaffected, pass.

Note: `depends_on: [2953]` (pushRaw-gap routing) did not block this — #2954
touches only `linear-emitter.ts` + `legality.ts` + test files; the trait
interface already declared every method. No `lower.ts` overlap.
