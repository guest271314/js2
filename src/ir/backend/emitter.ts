// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// BackendEmitter trait (#1713).
//
// The seam between IR-lowering *intent* (`src/ir/lower.ts` decides "read
// field N of this object", "build a closure cell", "box a scalar") and the
// concrete *ops* a backend emits ("WasmGC: struct.get typeIdx fieldIdx" vs
// "linear: i32.load offset" vs "bytecode: OP_GETFIELD slot").
//
// This generalises the pattern `lower.ts` already shipped for strings:
// `resolver.emitStringConst()` / `emitStringConcat()` / `emitStringEquals()`
// / `emitStringLen()` do NOT push WasmGC ops inline -- they delegate to the
// resolver because strings genuinely differ between backends (host externref
// vs native i16 array). `BackendEmitter` extends that to the struct / array /
// ref ops.
//
// Boundary contract:
//   - The emitter NEVER owns the `IrLowerResolver` (layout factory). `lower.ts`
//     resolves the layout handle (an `IrVecLowering` etc.) and passes it in.
//     Memoisation / registration stays in one place.
//   - Operand evaluation order is the CALLER's job: `lower.ts` emits operand
//     subtrees via `emitValue(v, out)` BEFORE calling an emitter primitive,
//     exactly as the inline code did. The emitter only pushes the *terminal*
//     op(s) for the node -- it never calls `emitValue`. SSA / materialisation
//     logic stays in `lower.ts`.
//   - Every method takes the output sink `out: Instr[]` and PUSHES onto it
//     (side-effecting `void` return), mirroring the original `out.push(...)`
//     call sites and the existing `emitValue(v, out)` helper. The emitter does
//     NOT return `Instr[]` to be spliced.
//
// Phase 1 (#1713) implements only the pass-through group (locals / globals /
// const / arithmetic / control flow) and the vec group; `WasmGcEmitter`
// produces a byte-identical `Instr` stream. The remaining methods
// (aggregate / union / closure / ref-coercion) are declared so #1714 / a
// later stage can route them, and are implemented in `WasmGcEmitter` as
// they get wired. Async (Promise) + string groups stay where they are in
// `lower.ts` for Phase 1 (strings are already behind `emit*` resolver
// methods; Promise/await is WasmGC-only with no linear analogue yet).
//
// The `out: Instr[]` sink is WasmGC/linear-shaped (both backends share the
// `Instr` union -- see codegen-axes "types.ts stays shared"). It does NOT fit
// bytecode (`number[]`); #1715 generalises the sink to reach a stack-VM. That
// generalisation is the #1715 deliverable, not a Phase-1 blocker.

import type { IrBinop, IrInstr, IrType, IrUnop } from "../nodes.js";
import type { BlockType, Instr } from "../types.js";
import type {
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
  LinearVecLowering,
} from "./handles.js";

// #1714: the vec primitives accept either backend's vec-layout handle. WasmGc
// uses IrVecLowering (typeIdx-based); Linear uses LinearVecLowering
// (offset-based). Each emitter narrows to its own shape. This is the
// "widen to a handle union" option from the #1713 spec section 7.
type VecLayout = IrVecLowering | LinearVecLowering;

export interface BackendEmitter {
  // ---- vec (array) -- the Phase-1 stage-2 primitives ------------------
  /**
   * vec ref on stack -> i32 length. The caller appends `f64.convert_i32_s`
   * when the IR result type is f64 (that is an IR-result-type coercion, not
   * a backend op, so it stays in lower.ts).
   */
  emitVecLen(layout: VecLayout, out: Instr[]): void;
  /**
   * vec ref on stack -> data-region handle. WasmGC leaves a `(ref $arr)`;
   * a linear backend would leave an `i32` base pointer. Both feed
   * `emitElemGet`, which closes the abstraction so `lower.ts` never reasons
   * about what is on the stack between the two calls.
   */
  emitVecDataPtr(layout: VecLayout, out: Instr[]): void;
  /** data-region handle + i32 index on stack -> element value. */
  emitElemGet(layout: VecLayout, out: Instr[]): void;

  // ---- scalars / locals / globals / control flow (Phase-1 stage 1) ----
  /** Emit a `const` IR instr's literal op(s). Delegates to the shared free fn. */
  emitConst(instr: Extract<IrInstr, { kind: "const" }>, funcName: string, out: Instr[]): void;
  /** Pass-through binary op (`f64.add`, `i32.eq`, `i32.and`, ...). Bitwise
   * `js.*` ops are lowered earlier in lower.ts and never reach here. */
  emitBinary(op: IrBinop, out: Instr[]): void;
  /** Pass-through unary op. */
  emitUnary(op: IrUnop, out: Instr[]): void;
  emitLocalGet(index: number, out: Instr[]): void;
  emitLocalSet(index: number, out: Instr[]): void;
  emitLocalTee(index: number, out: Instr[]): void;
  emitGlobalGet(index: number, out: Instr[]): void;
  emitGlobalSet(index: number, out: Instr[]): void;
  emitDrop(out: Instr[]): void;
  emitSelect(out: Instr[]): void;
  emitReturn(out: Instr[]): void;
  emitUnreachable(out: Instr[]): void;
  /** Structured if. then/else are already lowered into their own Instr[]. */
  emitIf(blockType: BlockType, then: Instr[], els: Instr[], out: Instr[]): void;
  emitBr(depth: number, out: Instr[]): void;
  emitBrIf(depth: number, out: Instr[]): void;

  // ---- NOT YET MOVED (declared for #1714+ staging; see issue Scope) ----
  // The following are part of the full seam the spec audited but are NOT
  // routed through the trait in Phase 1 (#1713). They remain inline in
  // lower.ts. Declared here so the staged groups (aggregate / union /
  // closure / ref-coercion) have a stable signature to migrate against and
  // #1714 knows the shape of the not-yet-moved surface. A `WasmGcEmitter`
  // need not implement them until its group is wired.
  emitAggregateNew?(layout: IrObjectStructLowering, fieldCount: number, out: Instr[]): void;
  emitBox?(layout: IrUnionLowering, out: Instr[]): void;
  emitFieldGet?(layout: IrObjectStructLowering | IrClassLowering, name: string, out: Instr[]): void;
  emitFieldSet?(layout: IrObjectStructLowering | IrClassLowering, name: string, out: Instr[]): void;
  emitUnbox?(layout: IrUnionLowering, out: Instr[]): void;
  emitTagLoad?(layout: IrUnionLowering, out: Instr[]): void;
  emitNull?(irType: IrType, out: Instr[]): void;
  emitToExternref?(out: Instr[]): void;
  emitFromExternref?(layout: { typeIdx: number } | IrType, out: Instr[]): void;
  emitFuncRef?(funcIdx: number, out: Instr[]): void;
  emitClosureNew?(layout: IrClosureLowering, captureCount: number, out: Instr[]): void;
  emitClosureFuncGet?(layout: IrClosureLowering, out: Instr[]): void;
  emitCaptureGet?(layout: IrClosureLowering, index: number, out: Instr[]): void;
  emitRefCellNew?(layout: IrRefCellLowering, out: Instr[]): void;
  emitRefCellGet?(layout: IrRefCellLowering, out: Instr[]): void;
  emitRefCellSet?(layout: IrRefCellLowering, out: Instr[]): void;
  emitCall?(funcIdx: number, out: Instr[]): void;
  emitCallRef?(funcTypeIdx: number, out: Instr[]): void;
}
