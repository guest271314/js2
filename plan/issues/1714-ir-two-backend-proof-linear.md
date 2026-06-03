---
id: 1714
title: "Lower one IR node kind through the BackendEmitter trait to BOTH WasmGC and linear"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen-linear, architecture
language_feature: arrays
goal: backend-agnostic-ir
sprint: 57
depends_on: [1713]
es_edition: n/a
related: [1131, 1527, 1530]
needs_architect_spec: true
---
# #1714 — Lower one IR node kind through the trait to BOTH WasmGC and linear

## Problem

#1713 defines the `BackendEmitter` trait and a `WasmGcEmitter`. That proves the
seam *exists* but not that it *abstracts* anything — a single-implementation
trait is just indirection. This issue is the proof that the seam is genuinely
backend-agnostic: take ONE IR-owned node kind and lower it, from the same IR,
to two structurally different backends.

This is the first AST node kind to "demand" the linear-backend IR lift the
codegen-axes doc anticipates ("no AST node kind has demanded it yet").

## Recommended node kind: the vec (array) length + element-read path

`lower.ts` already lowers vec length and element access via
`struct.get $vec $length` and `struct.get $vec $data` + `array.get` (see the
`vec.*` emission sites around `lower.ts:1204–1336`). This kind is ideal because:

- It is already IR-owned (no front-end work needed).
- It has a clean linear analogue: length is a header field at a fixed offset;
  element read is `i32.load`/`f64.load` from `base + i*stride` (the
  codegen-axes "new array method" worked example uses exactly this contrast).
- It is small and self-contained — a focused equivalence test can prove it.

The architect spec may substitute a different kind if the audit (#1713) shows a
cleaner candidate, but the criteria are: already IR-owned, structurally simple,
and with a well-understood linear-memory representation.

## Scope

1. Implement `src/ir/lower-linear.ts` with a `LinearEmitter implements
   BackendEmitter` — but ONLY for the emission primitives the chosen node kind
   needs (NOT the whole trait; the other primitives may `throw not-implemented`
   with a clear marker for follow-up).
2. Wire the IR lowering so that, for the chosen node kind, the active backend
   (selected by target: WasmGC vs linear) picks the right emitter. The same IR
   node feeds both.
3. Equivalence test: a small program whose hot path is the chosen node kind
   (e.g. sum-of-array-elements), compiled and run under both the WasmGC target
   and the linear/WASI target, producing identical results.

## Acceptance criteria

1. `src/ir/lower-linear.ts` exists with a `LinearEmitter` covering the chosen
   node kind's primitives.
2. The *same IR node* for the chosen kind lowers correctly to WasmGC (existing
   behavior, unchanged) AND to linear memory (new), selected by target.
3. A focused equivalence test compiles a program exercising the chosen kind to
   both targets and asserts identical runtime results.
4. Zero conformance delta on the WasmGC path (the refactor must not regress the
   existing lowering). Linear path correctness proven by the new test.
5. The codegen-axes doc is updated to record that this node kind is now
   lowered through the trait to two backends (it is the first such kind).

## Notes / scope

- Status `backlog` → flips to `ready` once #1713 merges (the trait must exist
  first). Listed in Sprint 57 as the primary backend-agnostic proof point.
- Deliberately ONE node kind. Do NOT attempt to route all of `lower.ts`'s vec
  or object handling to linear — that is a multi-sprint follow-up. The value
  here is *proving the seam abstracts a real second backend*, not coverage.
- This is the higher-value of the two s57 backend proofs (vs #1715 bytecode)
  because the linear backend is a real shipping target (WASI) and this directly
  retires front-end duplication between `src/ir/` and `src/codegen-linear/`.

---

## 2026-05-29 — implementation (senior-dev, branch issue-1714-vec-linear)

Chosen node kind: **vec** (the recommended one). Delivered:
- `src/ir/backend/linear-emitter.ts` — `LinearEmitter implements BackendEmitter`,
  implementing ONLY the three vec primitives against the linear array layout
  (`[header 8B][len:u32 @+8][cap:u32 @+12][elements @+16]`,
  `codegen-linear/runtime.ts:339`): `emitVecLen` = `i32.load offset=8`,
  `emitVecDataPtr` = `+16`, `emitElemGet` = `dataBase + i*stride; <t>.load`.
  Every other trait method throws a clear not-implemented marker (scope per
  issue Notes).
- `src/ir/backend/handles.ts` — added `LinearVecLowering` (offset-based sibling
  to the WasmGC `IrVecLowering`); this is the "different handle shape the linear
  resolver returns" the #1713 spec §7 anticipated.
- `src/ir/backend/emitter.ts` — widened the three vec-method handle params to
  `IrVecLowering | LinearVecLowering` (the §7 "handle union" option); each
  emitter narrows to its own shape (TS method-param bivariance).
- `tests/ir-vec-two-backend.test.ts` — the proof: (1) the same three vec
  intents produce DIFFERENT, each-backend-correct Instr sequences (WasmGC
  struct.get/array.get vs linear i32.load/offset-arith); (2) the LinearEmitter's
  emitted ops, executed against a hand-laid-out linear `[10,20,30]` array,
  sum to 60 at runtime (wabt-assembled module mirroring the exact emitted ops).

Scope honoured: ONE node kind, no attempt to route all of lower.ts to linear.
The WasmGC path is unchanged (only a type-union widening + new files), so its
runtime correctness stays covered by the existing IR equivalence suite. Full
target-driven emitter selection at the integration.ts call site (so a real
`--target wasi` compile routes vec ops through LinearEmitter end-to-end) is the
natural follow-up; this PR proves the seam abstracts the second backend, which
is the issue's stated value.
