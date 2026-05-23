# ADR-0013: Explicit allocation sites in the IR

Status: Accepted

## Context

The middle-end IR (`src/ir/`, ADR-0012) is a typed SSA representation. Several
pending compiler enhancements need the IR to answer "where was this value
allocated, and what do we know about it?" reliably across passes:

- Ownership and access-semantics analysis (#1587).
- String encoding tracking (#1588).
- Dual-target IR / lifetime analysis for a linear-memory backend (#1585).
- Closure-capture escape analysis (#747).

Before this decision, every value-creating IR instruction (`object.new`,
`closure.new`, `string.const`, …) was a distinct instr *kind*, but had no
stable, cross-pass identity and no channel for analyses to attach annotations.
The natural candidate identity, `IrValueId`, is a per-function SSA index that
**inlining** (`inline-small.ts`) and **monomorphization** (`monomorphize.ts`)
renumber — so it cannot serve as a durable allocation identity.

## Decision

Introduce an **`AllocSiteId`**: a module-global, brand-typed identity that
lives **on the instruction** (`IrInstrBase.alloc?`), not on the `IrValueId`.
Instructions are the thing passes clone and rewrite, so the id rides along
naturally and survives renumbering.

A module-scoped **`AllocSiteRegistry`** (`src/ir/alloc-registry.ts`), one per
compile, is the source of truth. It is a **flat array indexed by id** (O(1)
`fresh`/`resolve`, no hashing on the hot path) with three provenance states:
`live`, `aliased` (folded into another site), `retired` (proven dead). A
namespaced metadata map lets each analysis attach typed annotations without
touching the IR core.

`alloc` is **optional and inert at lowering** — emitted Wasm is byte-identical
whether or not it is set. This is the safety property behind "no behavioral
change": test builders and any non-module-driven construction simply omit it.

### `IrValueId` vs `AllocSiteId`

| | `IrValueId` | `AllocSiteId` |
|---|---|---|
| Scope | per-function SSA index | module-global |
| Survives inline/mono | no (renumbered) | yes |
| Carried on | the SSA value | the instruction (`alloc`) |
| Purpose | def-use / dominance | allocation provenance |

### Pass-discipline rules

Every pass that rewrites instrs keeps provenance honest:

1. **Preserve** ids through value-preserving rewrites (copy `alloc` verbatim).
2. **Alias** ids through fusion (`registry.alias(from, to)`) — for a future
   CSE pass; the hook exists today, no CSE pass is added here.
3. **Retire** ids on deletion or fold-away (`registry.retire(id)`).

**Clone forks the id.** Inlining or monomorphizing a callee that allocates
produces a *statically duplicated* allocation, which is a genuinely distinct
runtime allocation. The clone therefore gets a **fresh** id (kind/type copied
from the source site), not the source's id. Preserve only *within* one clone.
Getting this wrong would let escape analysis (#747) conflate two allocations.

Current passes: `dead-code` retires dropped allocs; `constant-fold` retires
folded-away allocs (a guard today — CF folds only non-alloc binary/unary);
`inline-small` and `monomorphize` fork; `simplify-cfg` is a no-op (moves whole
blocks only).

### Invariant checker

`verifyAllocProvenance` (`src/ir/verify-alloc.ts`) walks the IR after each pass
and asserts: (a) every value-creating instr carries a *live* id of the matching
kind, and (b) any `alloc` id is known and kind-consistent. It is gated behind
`IR_VERIFY_ALLOC=1` (free in production, on in CI's `quality` job) and runs at
the same `integration.ts` verify boundaries that already catch malformed SSA.

### Metadata namespaces (reserved)

| Namespace | Owner |
|---|---|
| `ownership` | #1587 |
| `encoding` | #1588 |
| `lifetime` | #1585 |
| `escape` | closure-capture escape analysis (#747) |

## Consequences

- Downstream analyses (#1587, #1588, #1585, #747) get stable anchor points and
  compose, instead of each recovering allocation info itself.
- The conservative checker forces audit gaps and discipline drift to surface in
  CI rather than later.
- Arrays currently route through the legacy/`object.new` path; there is no
  dedicated `array.new` IR instr yet, so array allocation remains black-box
  until a follow-up adds the instr. Built-in internal allocations
  (`<Class>_new`, `String_concat`, `__create_generator`, …) stay black-box by
  design — the IR tags the constructing *call's result* as the site.
- Prior art: LLVM `Value` provenance and MLIR op-attribute systems use the same
  registry + per-pass-discipline pattern.
