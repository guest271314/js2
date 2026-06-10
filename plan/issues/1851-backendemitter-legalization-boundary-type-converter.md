---
id: 1851
title: "Make BackendEmitter an explicit legalization boundary + extract a declared type-converter; add a backend-neutral mid-level"
status: done
completed: 2026-06-10
sprint: Backlog
created: 2026-06-04
updated: 2026-06-10
priority: medium
feasibility: hard
reasoning_effort: high
model: fable
task_type: refactor
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1713, 1714, 1715, 1185, 1168]
---
# #1851 — BackendEmitter as an explicit legalization boundary

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R4** (P2).

## Problem

The `BackendEmitter` trait (`src/ir/backend/emitter.ts`, with `wasmgc-`,
`linear-`, and `bytecode-emitter`) is the right seam, and the "vec" group
already routes through it to multiple backends (#1713/#1714/#1715). But the
backend boundary is still partly a hand-rolled lowering rather than an
explicit *legalization* step:

- `lower.ts` still emits `struct.new`/`struct.get`/`ref.cast` **inline** for
  the aggregate/closure/ref-coercion groups (tracked under #1713's migration
  order) — these are legalization leaks below the trait.
- `type-coercion.ts` is, in effect, our type-legalizer (externref boxing,
  i32↔f64, null/undefined-in-f64-context), but it isn't modeled as a
  *declared* type-converter consulted by the boundary.
- There is no single backend-neutral, Wasm-shaped mid-level (calls/locals/
  structured control resolved, object representation still abstract) where
  shared folding/peephole can run **once** before the GC-struct vs
  linear-load/store split.

## Recommendation

Model each backend as a **legality declaration + lowering-pattern set**
(which ops/types are legal; how illegal ones are rewritten) rather than an
imperative switch. "Is lowering finished?" becomes the checkable predicate
"only legal ops remain" (pairs with the per-backend legality check in
#1850/R1). Keep all lowering state **in the IR**, inspectable at every step —
not in opaque side tables.

## Acceptance criteria

- [ ] `type-coercion.ts` logic is reachable as a **declared type-converter**
      (`IrType` → backend value type) the boundary consults, with one home
      per backend.
- [ ] A **backend-neutral mid-level** exists above the struct-vs-linear
      split; shared fold/peephole (see #1853-adjacent / R8 via #1167a) runs
      there once for all backends.
- [ ] The remaining inline `struct.new`/`struct.get`/`ref.cast` in `lower.ts`
      (aggregate/closure/ref-coercion groups) route through the trait
      (continues #1713's migration order).
- [ ] No behavior change: equivalence + test262 green; cross-backend
      differential test (#1854) passes for the migrated groups.

## Implementation Plan — legalization boundary + declared type-converter (RATIFIED, sd-fable-arch, 2026-06-10)

### 0. Scope and inputs

Written after #1852 (per-backend dynamic-value representation) by design:
that spec fixes WHAT each backend's value representations are; this one fixes
HOW the boundary that applies them is declared and checked. Inputs verified
on main 2026-06-10: the trait (`src/ir/backend/emitter.ts`), the resolver
(`IrLowerResolver`, `src/ir/lower.ts:83-176`), the existing free-function
converter `lowerIrTypeToValType` (`lower.ts:2453-2525`), the shared passes
(`src/ir/passes/`: constant-fold, dead-code, simplify-cfg, inline-small,
monomorphize, tagged-unions), and the inline-GC-op leak inventory below.

### 1. Three named layers (mostly already exist — name them, then gate them)

1. **Mid-level IR** — the `IrInstr` stream after `from-ast` + `propagate` +
   `passes/*`, before `lowerIrFunc`. Calls/locals/structured control are
   resolved; object/closure/union/string representation is still abstract
   (`IrType` `object`/`closure`/`union`/`string`/`boxed`). This level is
   **backend-neutral by definition** and the shared passes already run here
   once for all backends — R4's "insert a backend-neutral level" is
   *satisfied by declaration*, not new code. What's missing is the gate:
   nothing today *checks* that a mid-level function contains no
   backend-committed artifact.
2. **Legalization** — `lowerIrFunc` + `BackendEmitter` + `IrLowerResolver`:
   rewrites every abstract-typed node into ops legal on the target backend.
3. **Backend ops** — the emitter's output (`Instr[]` sink for WasmGC/linear,
   `BytecodeSink` for the VM).

### 2. Legality declaration per backend

Each backend declares, as data (not control flow):

```ts
interface BackendLegality {
  /** IrInstr kinds the backend emits directly (pass-through). */
  legalOps: ReadonlySet<IrInstr["kind"]>;
  /** IrInstr kinds legalized via a trait primitive (the rewrite exists). */
  loweredOps: ReadonlySet<IrInstr["kind"]>;
  /** Everything else = illegal: lowering MUST refuse loudly (#1888 rule). */
}
```

"Is lowering finished?" becomes the checkable predicate **only legal ops
remain** — implemented as a post-lower verifier pass that walks the emitted
stream + a pre-lower check that every IrInstr kind in the function is in
`legalOps ∪ loweredOps`. This pairs with #1850 (verifier hardening): the
predicate lives in `src/ir/verify.ts` next to the existing structural checks
and runs under the same flag. A kind in neither set produces the same
loud-refusal channel as today's `ir/lower:` throws — never a silent demotion
(R6); the demote-to-warning path (`src/codegen/index.ts:889-896`) stays the
*selector's* fallback, not the legalizer's.

### 3. The declared type-converter (one home per backend)

Promote `lowerIrTypeToValType` (`lower.ts:2453`) from a GC-shaped free
function to a trait-owned conversion:

```ts
/** On the BackendEmitter trait. Slots, not a single ValType: the linear
 *  dynamic representation is a (value:i64, tag:i32) PAIR (#1852 §1-2), so
 *  one IrType may occupy >1 Wasm slot. GC backends always return 1 slot. */
convertType(t: IrType): readonly ValType[];
```

- `WasmGcEmitter.convertType` = today's `lowerIrTypeToValType` body
  (resolver-backed `(ref typeIdx)` for union/boxed/object/closure/class,
  `externref` for extern, `resolveString()` for string) — moved, not changed.
- `LinearEmitter.convertType` = scalars pass through; ref-likes → `i32`
  handle (matching `linearStride`, `linear-emitter.ts:42-55`); dynamic
  residue → the `[i64, i32]` pair per #1852.
- `BytecodeEmitter.convertType` = everything → one f64 slot (heap handles
  are `f64(heapIndex)`, `emitter.ts:176`).
- Multi-slot consequences are confined to local/param allocation and
  call-boundary marshalling inside `lowerIrFunc`; mid-level IR never sees
  slots. Param/result conversion sites: `lower.ts:2218-2219`.

Relationship to `src/codegen/type-coercion.ts`: that file remains the
**legacy direct-AST backend's** legalizer (externref boxing, i32↔f64,
branded-bigint frontier per #1924). It is a *fourth conversion target* in
spirit, not a competitor — the IR path must NOT call into it. Convergence
happens by IR adoption (#1530) shrinking the legacy path, not by merging the
two converters. This spec deliberately does not touch type-coercion.ts.

### 4. Leak inventory — inline backend ops above the trait (to close)

`lower.ts` still pushes WasmGC-committed ops via `pushRaw` (77 sites; 37 are
struct/cast ops). By group, with the #1713 migration order continued:

| Group | Sites (lower.ts) | Trait primitives | Slice |
|---|---|---|---|
| union box/unbox/tag.test | 897-967 | `emitBox`/`emitUnbox`/`emitTagLoad`/`emitTagTest` | #1852 G1 (already spec'd; counts toward this issue's AC too) |
| closure new/funcget/capture + call_ref cast | 1057-1115 | `emitClosureNew`/`emitClosureFuncGet`/`emitCaptureGet` (declared, emitter.ts:155-157) | L1 |
| ref-cell new/get/set | 1130-1195 | `emitRefCellNew`/`emitRefCellGet`/`emitRefCellSet` (declared, emitter.ts:158-160) | L1 |
| ref-coercion to/from externref | 1296-1313, 1481, generator bridges | `emitToExternref`/`emitFromExternref` (declared, emitter.ts:152-153) | L2 |
| string internals (`struct.get $AnyString`) | 1747 | extend the string resolver methods | L2 |
| async/Promise (`struct.new $Promise`, unwrap casts) | 1950-2070 | stays inline — WasmGC-only, no linear analogue (#1713 Phase-1 note, emitter.ts:37-38); declare the kinds illegal on linear/bytecode so the §2 predicate documents the gap honestly | deferred |

### 5. Slices (sized for Opus-tier devs)

- **L1 — closure + ref-cell groups behind the trait.** Implement the six
  declared-optional primitives in `WasmGcEmitter` byte-identically; replace
  the inline pushes; flip the methods from optional to required-for-GC.
  Mechanical, byte-identical output (same proof obligation as #1713 Phase 1:
  compare emitted `Instr` streams on the equivalence suite). ~150 LOC.
- **L2 — ref-coercion + string-internal leaks.** `emitToExternref`/
  `emitFromExternref` + the `$AnyString` field read behind the resolver.
  ~80 LOC. Independent of L1.
- **L3 — `convertType` extraction.** Move `lowerIrTypeToValType` onto the
  trait (§3), update the ~5 call sites (`lower.ts:521,851,2218-2219` + the
  box/unbox arms), implement linear/bytecode versions (linear dynamic pair
  may land as a loud `not-implemented` until #1852 G4). ~120 LOC. After L1
  (it touches the same arms).
- **L4 — legality declaration + verifier predicate.** §2's two sets per
  backend + the verify.ts pass; wire into the existing verifier flag; CI
  asserts the WasmGC declaration covers every IrInstr kind currently
  produced (snapshot test). Coordinates with #1850. ~150 LOC.
- **L5 — mid-level gate.** Assert (debug builds / verifier flag) that
  post-pass pre-lower functions contain no backend-committed artifact
  (no `pushRaw`-style raw `Instr`, no resolved typeIdx). Small; after L4.

Order: L1 → L3 → L4 → L5, with L2 parallel. #1852's G1/G4 interleave (G1
before L3; G4 after L3). The differential harness #1854 gates L3+ merges.

### 6. Acceptance criteria mapping

- "type-coercion logic reachable as a declared type-converter" → §3/L3 for
  the IR path (type-coercion.ts itself stays the legacy backend's legalizer
  — see §3's explicit non-goal).
- "backend-neutral mid-level + shared fold/peephole runs once" → §1 naming +
  L5 gate; the passes already run there (no code motion needed).
- "remaining inline struct.new/struct.get/ref.cast route through the trait"
  → §4 table; L1/L2 + #1852 G1 close all non-deferred groups; async/Promise
  is the one declared-deferred residue.
- "no behavior change; equivalence + test262 green; differential test for
  migrated groups" → byte-identical-stream proof on L1/L2/L3; #1854 rows
  for closures/ref-cells once the linear arms exist.
