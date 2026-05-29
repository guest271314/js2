---
id: 1713
title: "IR backend-trait: audit WasmGC bias in lower.ts + define BackendEmitter seam"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: ir, codegen, architecture
language_feature: n/a
es_edition: n/a
goal: backend-agnostic-ir
sprint: 57
related: [1131, 1527, 1530, 1584, 1714, 1715]
needs_architect_spec: true
---
# #1713 — IR backend-trait: audit WasmGC bias in `lower.ts` + define a `BackendEmitter` seam

## Problem

`src/ir/lower.ts` (~2,460 lines) is the IR→Wasm emission pass. It emits WasmGC
ops (`struct.new`, `struct.get`, `struct.set`, `array.get`, `ref.cast`,
`array.new_fixed`, …) **inline in its per-IR-node switch**. There is no backend
boundary: the mapping from IR-node intent ("read field N of this object",
"build a closure cell", "box a scalar") to concrete WasmGC ops is hardcoded.

The codegen-axes doc (`docs/architecture/codegen-axes.md`, "Current hidden bias
in `src/ir/`" table) already enumerates the leak points and states the intent:

> The architecture admits an IR adoption on the linear backend (a
> `lower-linear.ts` sibling) … When [a node kind demands it], the lift becomes
> worth the cost.

This issue does that lift's *foundation*: extract a `BackendEmitter` trait so a
backend becomes a visitor over IR-node emission intents, not a hardcoded switch
arm. It blocks both #1714 (lower one kind to two backends) and #1715 (bytecode
proof) — neither can proceed until the seam exists.

## Why `feasibility: hard` / needs architect spec

This touches the central IR emission pass. The risk is a behavior-changing
refactor regressing test262. The design questions that need an architect spec
before any dev work:

1. **Granularity of the trait.** Too fine (one method per Wasm op) and it's
   just a renamed `Instr` constructor — no abstraction. Too coarse (one method
   per IR node kind) and each backend re-implements the whole switch. The right
   level is *semantic emission primitives*: `emitStructNew(layout, fields)`,
   `emitFieldGet(layout, fieldName)`, `emitFieldSet`, `emitArrayGet(elemType)`,
   `emitArrayLen`, `emitBoxScalar(valType)`, `emitUnboxScalar`,
   `emitClosureCell`, `emitCallRef(sig)`, `emitConst`, `emitLocalGet/Set`,
   `emitBranch`, `emitReturn`. The architect must enumerate the actual set by
   walking `lower.ts`'s emission sites and clustering them.
2. **Where layout decisions live.** The WasmGC layout (`union.typeIdx`,
   `obj.fieldIdx(name)`, `vec.arrayTypeIdx`) is computed in the alloc-registry
   passes. The trait must take *abstract layout handles* (a struct identity, a
   field name) and let the backend resolve them to its representation (a WasmGC
   typeIdx vs a linear-memory offset vs a bytecode constant-pool index). The
   spec must decide what the layout-handle type is and how the `WasmGcEmitter`
   maps it back to today's `typeIdx`/`fieldIdx`.
3. **Type representation at the seam.** `IrType` is already backend-neutral
   (`nodes.ts` separates it from `ValType`). Confirm the trait consumes
   `IrType`/abstract layout handles, never raw `ValType`/`typeIdx`, except
   inside `WasmGcEmitter`.

## Scope (Sprint 57)

Phase 1 — the seam + behavior-identical WasmGC implementation. NOT a second
backend (that's #1714/#1715).

1. Architect writes `## Implementation Plan` enumerating the emission primitive
   set, the layout-handle abstraction, and the `lower.ts` call sites that move
   behind each primitive (with line refs against current main).
2. Define `BackendEmitter` interface (likely `src/ir/backend/emitter.ts`).
3. Implement `WasmGcEmitter implements BackendEmitter` (likely
   `src/ir/backend/wasmgc-emitter.ts`) that produces the *exact same* `Instr`
   stream `lower.ts` produces today.
4. Refactor `lower.ts` to route emission through the trait instance instead of
   pushing `Instr`s inline, for the node kinds the spec covers. (The spec may
   stage this — not every node kind must move in one PR; the audit defines the
   order. A partial but clean seam is acceptable as long as the moved kinds are
   100% behind the trait and the rest are explicitly flagged as not-yet-moved.)
5. Update the codegen-axes "Current hidden bias" table to mark which leaks are
   now behind the trait.

## Acceptance criteria

1. A `BackendEmitter` trait exists, consumed by `lower.ts`; a `WasmGcEmitter`
   implements it.
2. **Zero conformance delta** — this is a pure refactor. test262 pass count is
   unchanged (±0 net; any change is a bug). The IR fallback budget
   (`pnpm run check:ir-fallbacks`) does not grow.
3. The emission primitives the spec enumerated are routed through the trait;
   `lower.ts` no longer pushes WasmGC `Instr`s inline for those node kinds.
4. The codegen-axes doc "Current hidden bias" table is updated.
5. The architect spec (`## Implementation Plan`) is committed in this issue
   before dev dispatch.

## Notes / scope

- This is the enabling refactor. It must NOT try to also add a second backend
  — that scope is #1714 (linear) and #1715 (bytecode), which depend on this.
- Keep `src/ir/types.ts` (the shared Wasm `Instr` union) as-is — per the
  codegen-axes doc it is shared Wasm-encoding bookkeeping, not IR coupling. The
  trait sits *above* `Instr`; `WasmGcEmitter` still produces `Instr`.
- Reasoning effort high; route to architect for the spec before any dev claims.
