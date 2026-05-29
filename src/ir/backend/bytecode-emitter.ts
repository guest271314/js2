// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// BytecodeEmitter (#1715) — the backend-agnostic proof point.
//
// Throwaway-grade by design (issue #1715): the deliverable is *knowledge + a
// green triple-equivalence test*, not production code. It exists to de-risk the
// single architectural claim #1584's bytecode-VM investment rests on:
//
//   > Can the typed IR be lowered to a NON-Wasm execution target (a bytecode
//   > stream run by a dispatch loop) through the same backend seam (#1713) that
//   > targets WasmGC?
//
// ## What this proves
//
// The #1713 `BackendEmitter` trait abstracts *op emission* — `lower.ts` decides
// intent ("push a const", "add the top two operands", "branch if zero") and the
// emitter decides the concrete ops. `WasmGcEmitter` turns that intent into
// `Instr[]` (`{ op: "f64.add" }`). This `BytecodeEmitter` turns the SAME intent
// into a flat opcode stream (`OP_ADD`) for a stack VM (`bytecode-vm.ts`). Same
// primitive set, same operand-evaluation contract (caller pushes operand
// subtrees first), different execution model. That is the proof.
//
// ## The one seam generalisation this required (the #1715 finding)
//
// `BackendEmitter`'s methods take `out: Instr[]` and push `Instr` objects. That
// sink is WasmGC/linear-shaped — both share the `Instr` union (codegen-axes
// "types.ts stays shared"). It does NOT fit a bytecode target, whose natural
// sink is a flat `number[]`. So reaching bytecode needed exactly ONE seam
// change: generalise the sink from the concrete `Instr[]` to an abstract
// {@link BytecodeSink} here. Everything else about the trait — the primitive
// SET, the push-to-sink convention, the caller-owns-operand-order contract —
// transferred unchanged. **That single, well-contained generalisation is the
// answer #1715 set out to find**: the trait abstracts the *execution model*,
// and the sink type is the one place that is representation-specific. The
// encoding (stack vs register+accumulator) is a free choice *below* the seam —
// the seam does not care (see issue write-up §6).
//
// Scope is deliberately minimal (#1715): integer/f64 arithmetic (add/sub/mul),
// local get/set, const, return, ONE conditional branch. NO objects/arrays/
// closures/calls/strings/exceptions — those are #1584's job. This is exactly
// the IR subset `lower.ts` already handles for
// `function f(a, b) { return a > 0 ? a + b : a - b; }`.
//
// Encoding: STACK MACHINE (issue §6 tiebreaker — "a stack machine is acceptable
// for the proof if simpler"). `lower.ts`'s emission is already stack-oriented
// (operands pushed by `emitValue`, then the op consumes them), so a stack-VM
// opcode per primitive is a near-mechanical mirror of `WasmGcEmitter` and reuses
// the existing operand-ordering logic with the least throwaway code. #1584 wants
// register+accumulator for the eventual VM; this proof documents that that delta
// is purely an *encoding* concern downstream of the same seam.
//
// This file is behind no production code path — it is reached only by the
// #1715 test. It does NOT touch `lower.ts`, `WasmGcEmitter`, or the default
// compile pipeline, so it carries zero conformance risk (issue AC #5).

import type { IrBinop, IrUnop } from "../nodes.js";

// ── Opcodes ───────────────────────────────────────────────────────────────
// A flat `number[]` instruction stream. Each opcode is one int; inline operands
// (a local index, a constant-pool index, a jump target) are the ints that
// follow it. f64 immediates live in a side constant pool (see BytecodeSink) so
// the code array stays integer-only — the dispatch loop reads them by index.
export const OP = {
  CONST: 0, //  CONST <poolIdx>      ; push constPool[poolIdx]
  LOAD: 1, //   LOAD  <localIdx>     ; push frame.locals[localIdx]
  STORE: 2, //  STORE <localIdx>     ; pop -> frame.locals[localIdx]
  ADD: 3, //    ADD                  ; pop b, pop a, push a + b
  SUB: 4, //    SUB                  ; pop b, pop a, push a - b
  MUL: 5, //    MUL                  ; pop b, pop a, push a * b
  // Comparisons (the conditional branch needs a compare). Result is 1.0 / 0.0.
  CMP_GT: 6, // CMP_GT               ; pop b, pop a, push (a >  b) ? 1 : 0
  CMP_LT: 7, // CMP_LT               ; pop b, pop a, push (a <  b) ? 1 : 0
  CMP_GE: 8, // CMP_GE               ; pop b, pop a, push (a >= b) ? 1 : 0
  CMP_LE: 9, // CMP_LE               ; pop b, pop a, push (a <= b) ? 1 : 0
  CMP_EQ: 10, // CMP_EQ              ; pop b, pop a, push (a == b) ? 1 : 0
  NEG: 11, //   NEG                  ; pop a, push -a
  JZ: 12, //    JZ <target>          ; pop c; if c == 0 goto target  (maps from emitBrIf/emitIf)
  JMP: 13, //   JMP <target>         ; goto target                   (maps from emitBr)
  RET: 14, //   RET                  ; halt, return top-of-stack
} as const;

export type Opcode = (typeof OP)[keyof typeof OP];

/**
 * The bytecode equivalent of `BackendEmitter`'s `Instr[]` sink — the ONE seam
 * generalisation #1715 required. A flat `code` opcode stream plus a side
 * constant pool for f64 immediates. A label backpatch list lets `emitIf`
 * forward-reference jump targets it does not yet know.
 */
export class BytecodeSink {
  readonly code: number[] = [];
  readonly constPool: number[] = [];

  /** Intern an f64 immediate into the constant pool, returning its index. */
  internConst(value: number): number {
    // Linear scan is fine — proof-grade, programs are tiny.
    const existing = this.constPool.indexOf(value);
    if (existing >= 0) return existing;
    this.constPool.push(value);
    return this.constPool.length - 1;
  }

  /** Current write position (a jump target / patch site is a code index). */
  here(): number {
    return this.code.length;
  }

  /** Emit an opcode followed by zero or more inline integer operands. */
  emit(op: Opcode, ...operands: number[]): void {
    this.code.push(op, ...operands);
  }

  /**
   * Emit a jump whose target is not yet known; returns the code index of the
   * *operand slot* to backpatch once the target is known.
   */
  emitJumpPlaceholder(op: typeof OP.JZ | typeof OP.JMP): number {
    this.code.push(op, -1); // -1 = unpatched
    return this.code.length - 1; // index of the operand slot
  }

  /** Fill a previously-reserved jump operand slot with the resolved target. */
  patch(slot: number, target: number): void {
    this.code[slot] = target;
  }
}

/**
 * Maps an IR binop tag to a stack-VM opcode for the #1715 subset. Ops outside
 * the subset throw `not-supported-in-proof` — exactly the #1715 contract
 * ("only the primitives the subset needs; the rest throw").
 */
function binopToOpcode(op: IrBinop): Opcode {
  switch (op) {
    case "f64.add":
      return OP.ADD;
    case "f64.sub":
      return OP.SUB;
    case "f64.mul":
      return OP.MUL;
    case "f64.gt":
    case "i32.gt_s":
      return OP.CMP_GT;
    case "f64.lt":
    case "i32.lt_s":
      return OP.CMP_LT;
    case "f64.ge":
    case "i32.ge_s":
      return OP.CMP_GE;
    case "f64.le":
    case "i32.le_s":
      return OP.CMP_LE;
    case "f64.eq":
    case "i32.eq":
      return OP.CMP_EQ;
    default:
      throw new Error(`BytecodeEmitter: binop '${op}' not supported in proof (#1715 subset is add/sub/mul + compares)`);
  }
}

/**
 * Emits the #1715 IR subset to a {@link BytecodeSink} stack-VM stream. Mirrors
 * the relevant `BackendEmitter` primitives (`emitConst`, `emitBinary`,
 * `emitLocalGet/Set`, `emitReturn`, plus the branch helpers) but over a bytecode
 * sink instead of `Instr[]`. The caller (the test's tiny hand-lowerer, standing
 * in for `lower.ts`) owns operand evaluation order: it emits operand subtrees
 * before calling the terminal-op primitive, exactly as `lower.ts` does.
 */
export class BytecodeEmitter {
  emitConst(value: number, out: BytecodeSink): void {
    out.emit(OP.CONST, out.internConst(value));
  }

  emitBinary(op: IrBinop, out: BytecodeSink): void {
    out.emit(binopToOpcode(op));
  }

  emitUnary(op: IrUnop, out: BytecodeSink): void {
    if (op === "f64.neg") {
      out.emit(OP.NEG);
      return;
    }
    throw new Error(`BytecodeEmitter: unary '${op}' not supported in proof (#1715 subset is f64.neg)`);
  }

  emitLocalGet(index: number, out: BytecodeSink): void {
    out.emit(OP.LOAD, index);
  }

  emitLocalSet(index: number, out: BytecodeSink): void {
    out.emit(OP.STORE, index);
  }

  emitReturn(out: BytecodeSink): void {
    out.emit(OP.RET);
  }

  /**
   * Structured two-arm conditional, the ONE branch the subset needs. The
   * condition value is already on the stack (caller emitted it). `then`/`els`
   * are thunks that emit their arm's opcodes into `out` when invoked — this
   * mirrors `BackendEmitter.emitIf(blockType, then: Instr[], els: Instr[])`,
   * adapted so the arms write into the same flat stream with backpatched jumps
   * (the stack VM has no structured block, so we lower to JZ/JMP + labels).
   *
   * Lowering (matches issue §6):
   *   <cond on stack>
   *   JZ elseLabel
   *   <then ops>
   *   JMP endLabel
   *   elseLabel: <else ops>
   *   endLabel:
   */
  emitIf(cond: () => void, then: () => void, els: () => void, out: BytecodeSink): void {
    cond();
    const toElse = out.emitJumpPlaceholder(OP.JZ);
    then();
    const toEnd = out.emitJumpPlaceholder(OP.JMP);
    out.patch(toElse, out.here());
    els();
    out.patch(toEnd, out.here());
  }
}
