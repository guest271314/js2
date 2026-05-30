// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1584 — PRODUCTION BytecodeEmitter. Implements the backend-primitive surface
// the #1713 `BackendEmitter` trait routes, but over a {@link BytecodeSink}
// (a flat opcode stream) instead of `Instr[]`. This is the productionization of
// the #1715 proof's hand-driven `BytecodeEmitter`: the SAME primitives, now
// invoked by the REAL `lower.ts`-shaped IR walk in `lower-bytecode.ts` rather
// than a test's hand-lowerer.
//
// ## Why a parallel emitter, not a generic `BackendEmitter<S>`
//
// The #1713 trait's methods take `out: Instr[]`. Threading a generic sink type
// `S` through the trait would force `lowerIrFunctionToWasm` to be generic too —
// but that function has **166 inline `out.push({ op })` sites** (call,
// struct.get/new/set, try/throw/rethrow, loop/block/br_if, the js-bitwise
// scratch dance, ref-coercion) that are NOT yet routed through the trait and
// hard-require `S = Instr[]`. Making lower.ts generic over those would either
// (a) break their type-checking, or (b) demand migrating all 166 first — a
// large, conformance-risky refactor that is #1584's later op-group slices, not
// this one.
//
// So this emitter mirrors the trait's primitive SIGNATURES (so the bytecode
// lowering walk drives it identically to how lower.ts drives WasmGcEmitter)
// without claiming to implement `BackendEmitter` (whose `out` is `Instr[]`).
// The bytecode lowering walk (`lower-bytecode.ts`) covers exactly the routed
// subset and throws loudly on any out-of-subset node — the not-yet-migrated
// boundary surfaces as a clear error, never a silent mis-lowering. As #1584
// migrates an op group behind the trait, that node kind graduates from "throws
// in lower-bytecode" to "emits an opcode here".
//
// The opcode set lives in `opcodes.ts` (the single source of truth the VM
// imports read-only). This file only decides which opcode each primitive emits.

import type { IrBinop, IrInstr, IrUnop } from "../../nodes.js";
import { BytecodeSink, OP, binopToOpcode, unopToOpcode } from "./opcodes.js";

/**
 * Production bytecode emitter over a {@link BytecodeSink}. Each method is the
 * stack-VM analogue of the corresponding `WasmGcEmitter` method: where the
 * WasmGC emitter pushes an `Instr` object, this pushes an opcode (+ inline
 * operands). The caller (`lower-bytecode.ts`) owns operand-evaluation order —
 * it emits operand subtrees before calling a terminal-op primitive — exactly
 * the contract `lower.ts` honours for the WasmGC backend.
 */
export class BytecodeEmitter {
  // ---- scalars / locals / globals -------------------------------------

  emitConst(instr: Extract<IrInstr, { kind: "const" }>, funcName: string, out: BytecodeSink): void {
    const v = instr.value;
    switch (v.kind) {
      case "i32":
      case "f32":
      case "f64":
        out.emit(OP.CONST, out.internConst(v.value));
        return;
      case "i64":
        // i64 immediates are not in the numeric stack-VM domain (the VM is
        // f64-valued). A bigint-branded i64 representation (#1644) would be a
        // separate boxed opcode; out of the #1584 subset.
        throw new Error(`bytecode: i64 const not in #1584 subset (${funcName})`);
      case "bool":
        out.emit(OP.CONST, out.internConst(v.value ? 1 : 0));
        return;
      case "null":
      case "undefined":
        throw new Error(`bytecode: const '${v.kind}' not in #1584 numeric subset (${funcName})`);
    }
  }

  emitBinary(op: IrBinop, out: BytecodeSink): void {
    out.emit(binopToOpcode(op));
  }

  emitUnary(op: IrUnop, out: BytecodeSink): void {
    out.emit(unopToOpcode(op));
  }

  emitLocalGet(index: number, out: BytecodeSink): void {
    out.emit(OP.LOAD, index);
  }

  emitLocalSet(index: number, out: BytecodeSink): void {
    out.emit(OP.STORE, index);
  }

  emitLocalTee(index: number, out: BytecodeSink): void {
    out.emit(OP.TEE, index);
  }

  emitGlobalGet(index: number, out: BytecodeSink): void {
    out.emit(OP.GLOBAL_GET, index);
  }

  emitGlobalSet(index: number, out: BytecodeSink): void {
    out.emit(OP.GLOBAL_SET, index);
  }

  // ---- stack / control flow -------------------------------------------

  emitDrop(out: BytecodeSink): void {
    out.emit(OP.DROP);
  }

  emitSelect(out: BytecodeSink): void {
    out.emit(OP.SELECT);
  }

  emitReturn(out: BytecodeSink): void {
    out.emit(OP.RET);
  }

  emitUnreachable(out: BytecodeSink): void {
    out.emit(OP.UNREACHABLE);
  }

  /**
   * Structured two-arm conditional. Mirrors `WasmGcEmitter.emitIf(blockType,
   * then: Instr[], els: Instr[], out)`: the caller pre-lowers each arm into its
   * own {@link BytecodeSink} buffer (as `lower.ts` builds `thenBody`/`elseBody`
   * as separate `Instr[]`), then hands them here. The cond value is already on
   * the stack (the caller emitted it). We lower to JZ/JMP + spliced arms — the
   * stack VM has no structured block, so the structured `if` becomes:
   *
   *   <cond on stack>
   *   JZ elseLabel
   *   <then arm>
   *   JMP endLabel
   *   elseLabel: <else arm>
   *   endLabel:
   *
   * `spliceArm` relocates each arm's internal jump targets into `out`'s address
   * space, so arms may themselves contain nested `if`s (nested JZ/JMP).
   */
  emitIf(then: BytecodeSink, els: BytecodeSink, out: BytecodeSink): void {
    const toElse = out.emitJumpPlaceholder(OP.JZ);
    out.spliceArm(then);
    const toEnd = out.emitJumpPlaceholder(OP.JMP);
    out.patch(toElse, out.here());
    out.spliceArm(els);
    out.patch(toEnd, out.here());
  }
}
