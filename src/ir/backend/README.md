# `src/ir/backend/` — the backend contract (R-OWN)

**Responsibility:** the five-part contract a backend implements (#3029-S1
freeze, `contract.ts`) plus the in-tree realizations: the `BackendEmitter`
trait (`emitter.ts`) with its WasmGC / linear / bytecode implementations,
the per-backend legality checker (`legality.ts`), and the layout-handle
shapes (`handles.ts`).

Normative background: `docs/architecture/target-architecture.md` ("The
backend contract"). Target home after #3029-S6: `src/backend/contract/`.

## The five parts and what each OWNS

| Part                     | File                                    | Owns                                                                                                                         | Must NOT do                                                                   |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 `TypeConverter`        | `contract.ts` (decl; #1851 L3 promotes) | IR type → backend value slot(s). Slot COUNT is backend policy (GC: always 1; linear dynamic: value+tag pair, #1852 §1)       | memoize layouts (that's part 4); inspect instructions                         |
| 2 `BackendLegality`      | `legality.ts` (+ `legalityFor`)         | The pre-lowering "can I lower this function?" verdict; localized diagnostics                                                 | mutate the IR; emit anything                                                  |
| 3 `BackendEmitter<Sink>` | `emitter.ts` + `*-emitter.ts`           | Terminal op emission per IR intent, onto an opaque `Sink`                                                                    | evaluate operands (caller's job); own layout handles; resolve names/indices   |
| 4 `LayoutResolver`       | decl in `lower.ts` (`IrLowerResolver`)  | Shape → memoized layout handle; string/boxing emission helpers. **All memoization lives here** (one struct per shape/module) | emit per-instruction ops (part 3); assign module indices (part 5)             |
| 5 `ModuleAssembler`      | `contract.ts` (decl; #3029-S5 impls)    | Function slots, imports/exports, globals, type interning, start — **index identity** (invariants A1–A7 in `contract.ts`)     | expose a module index before `finalize()`; permit index arithmetic on handles |

## Operand-order rules (part 3, load-bearing)

- The **caller** (`lower.ts`) emits operand subtrees onto the sink BEFORE
  invoking an emitter primitive; the primitive pushes only the TERMINAL
  op(s). The emitter never calls back into value emission.
- Multi-region primitives (`emitIf`, `emitBlock`, `emitLoop`, `emitTry`)
  receive pre-lowered regions built via `newSink()`; branch depths inside a
  region are De Bruijn (count block/loop nesting outward).
- Stack conventions per primitive are documented on the method in
  `emitter.ts` (e.g. `emitVecNewFixed`: e0 deepest … eN on top).

## Escape hatches (R-ESCAPE)

`pushRaw` is the ONE sanctioned bypass of part 3, and it is ratcheted:
#2953 migrates the remaining families (74 sites in `lower.ts` at freeze
time) behind typed primitives and adds the `// pushraw-ok(#issue)` tag +
count check. New `pushRaw` sites without a tag are a review reject.

## Freeze rules (#3029-S1)

- Adding a method to a contract interface: **allowed** (additive).
- Removing/re-typing a frozen member: breaking — needs an issue + wave.
- A new backend implements the five interfaces (in-tree) or consumes the
  serialized IR (#3030, out-of-tree). Never a fourth hand-rolled path.
- Conformance: `contract-conformance.ts` must keep compiling — it proves
  the three emitters satisfy `BackendEmitter<Sink>` with their own sinks
  and that a from-scratch stub can implement all five parts.

## Dependencies (R-DEP)

May import: `src/ir/` (nodes, types), `src/emit/resolve-layout.ts`
(`ModuleLayout` — the finalize output type). Must NOT import:
`src/codegen/**` (the WasmGC context is BELOW the contract — adapters
implementing these interfaces over `ctx.mod` live on the codegen side,
#3029-S5), `src/codegen-linear/**`.
