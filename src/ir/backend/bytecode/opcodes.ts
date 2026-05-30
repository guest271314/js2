// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1584 — PRODUCTION bytecode opcode set + sink. This file is the SINGLE
// SOURCE OF TRUTH for the opcode contract. The VM (`bytecode/vm.ts`, owned by
// the sdev-vm track) imports this READ-ONLY; do not duplicate the opcode
// numbers anywhere else.
//
// ## Lineage
//
// This productionizes the #1715 proof (`src/ir/backend/bytecode-emitter.ts`).
// The proof established — with a green triple-equivalence test — that the
// #1713 `BackendEmitter` seam can target a non-Wasm execution model (a flat
// opcode stream run by a dispatch loop) using the SAME primitive set and the
// SAME caller-owns-operand-order contract that targets WasmGC. The proof drove
// the emitter from HAND-LOWERED IR; this production track drives it from the
// REAL `lower.ts` IR built by the front-end from source.
//
// ## Encoding decision (#1584 ADR input)
//
// STACK MACHINE. The #1715 proof validated a stack VM, and `lower.ts`'s
// emission is already stack-oriented: `emitValue(v, out)` pushes operand
// subtrees, then the terminal-op primitive (`emitBinary`, `emitReturn`, …)
// consumes them. A stack-VM opcode per primitive is therefore a near-mechanical
// mirror of `WasmGcEmitter` and reuses lower.ts's existing operand-ordering
// logic with zero new sequencing code. #1584's eventual VM may move to
// register+accumulator (after Ignition) for dispatch-loop throughput; that is
// an ENCODING choice strictly BELOW this seam — the seam (lower.ts → sink) does
// not change, only the opcode set + VM dispatch do. If the architect's #1584
// contract pins reg+acc, this opcode table changes and `vm.ts` follows; the
// sink abstraction and the lower.ts wiring are unaffected. See the #1715
// finding write-up in `plan/issues/1715-ir-bytecode-proof-point.md`.

import type { IrBinop, IrUnop } from "../../nodes.js";

// ── Opcodes ───────────────────────────────────────────────────────────────
// A flat `number[]` instruction stream. Each opcode is one int; inline operands
// (a local index, a constant-pool index, a jump target) are the ints that
// follow it. f64 immediates live in a side constant pool so the code array
// stays integer-only — the dispatch loop reads them by index.
//
// The set is the #1715-routed subset: the primitives the #1713 `BackendEmitter`
// trait routes today (locals/globals/const/arithmetic/control flow), which is
// exactly what the real `lower.ts` can drive through a non-`Instr[]` sink
// without touching its 166 not-yet-migrated inline `out.push` sites. #1584's
// later slices grow this set (calls, fields, closures, exceptions) as those
// op groups migrate behind the trait — each addition is announced to sdev-vm.
export const OP = {
  CONST: 0, //  CONST <poolIdx>      ; push constPool[poolIdx]
  LOAD: 1, //   LOAD  <localIdx>     ; push frame.locals[localIdx]
  STORE: 2, //  STORE <localIdx>     ; pop -> frame.locals[localIdx]
  TEE: 3, //    TEE   <localIdx>     ; peek top -> frame.locals[localIdx] (leaves it on stack)
  GLOBAL_GET: 4, // GLOBAL_GET <gIdx> ; push globals[gIdx]
  GLOBAL_SET: 5, // GLOBAL_SET <gIdx> ; pop -> globals[gIdx]
  ADD: 6, //    ADD                  ; pop b, pop a, push a + b
  SUB: 7, //    SUB                  ; pop b, pop a, push a - b
  MUL: 8, //    MUL                  ; pop b, pop a, push a * b
  DIV: 9, //    DIV                  ; pop b, pop a, push a / b
  // Comparisons. Result is 1.0 / 0.0 (matching Wasm's i32 0/1 + JS truthiness
  // for the JZ branch).
  CMP_GT: 10, // CMP_GT              ; pop b, pop a, push (a >  b) ? 1 : 0
  CMP_LT: 11, // CMP_LT              ; pop b, pop a, push (a <  b) ? 1 : 0
  CMP_GE: 12, // CMP_GE              ; pop b, pop a, push (a >= b) ? 1 : 0
  CMP_LE: 13, // CMP_LE              ; pop b, pop a, push (a <= b) ? 1 : 0
  CMP_EQ: 14, // CMP_EQ              ; pop b, pop a, push (a == b) ? 1 : 0
  CMP_NE: 15, // CMP_NE              ; pop b, pop a, push (a != b) ? 1 : 0
  NEG: 16, //   NEG                  ; pop a, push -a
  // `select`: Wasm pops [v1, v2, cond] → v1 if cond!=0 else v2.
  SELECT: 17, // SELECT              ; pop cond, pop b, pop a, push (cond != 0) ? a : b
  DROP: 18, //  DROP                 ; pop and discard
  JZ: 19, //    JZ <target>          ; pop c; if c == 0 goto target  (from emitBrIf / emitIf cond)
  JMP: 20, //   JMP <target>         ; goto target                   (from emitBr / emitIf skip-else)
  RET: 21, //   RET                  ; halt, return top-of-stack
  UNREACHABLE: 22, // UNREACHABLE    ; trap (malformed / dead code path)
} as const;

export type Opcode = (typeof OP)[keyof typeof OP];

/**
 * The bytecode equivalent of `BackendEmitter`'s `Instr[]` sink — the ONE seam
 * generalisation the #1715 finding identified. A flat `code` opcode stream plus
 * a side constant pool for f64 immediates. A label backpatch mechanism lets
 * forward branches reference jump targets not yet emitted.
 *
 * This is the production sink the real `lower.ts` writes into when the active
 * backend is the {@link BytecodeEmitter}. It is deliberately the SAME shape the
 * proof used (`code:number[]` + `constPool:number[]`) so the VM is unchanged in
 * spirit; the difference is that `lower.ts` — not a hand-lowerer — now drives
 * the emitter primitives that push onto it.
 */
export class BytecodeSink {
  readonly code: number[] = [];
  readonly constPool: number[] = [];

  /** Intern an f64 immediate into the constant pool, returning its index. */
  internConst(value: number): number {
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

  /**
   * Append another sink's code at the current position, returning the base
   * offset the appended code was placed at so its internal jump targets can be
   * relocated. Used by `emitIf` to splice already-lowered arm buffers
   * (`lower.ts` builds each arm into its own buffer, exactly as it does for the
   * WasmGC `if`'s `then`/`else` `Instr[]`).
   *
   * Jump operands inside `arm` are sink-relative; this rebases them by `base`.
   * Const-pool indices are remapped through `internConst` so two arms that each
   * interned the same literal collapse to one pool slot.
   */
  spliceArm(arm: BytecodeSink): void {
    const base = this.code.length;
    // First pass: copy code, remapping const-pool indices.
    const code = arm.code;
    let i = 0;
    while (i < code.length) {
      const op = code[i++] as Opcode;
      switch (op) {
        case OP.CONST: {
          const localPoolIdx = code[i++]!;
          this.code.push(OP.CONST, this.internConst(arm.constPool[localPoolIdx]!));
          break;
        }
        case OP.JZ:
        case OP.JMP: {
          const target = code[i++]!;
          // Relocate the target into the parent's address space. -1 (unpatched)
          // must never appear in a spliced arm — arms are self-contained.
          if (target < 0) {
            throw new Error("BytecodeSink.spliceArm: arm contains an unpatched jump (internal error)");
          }
          this.code.push(op, target + base);
          break;
        }
        // Opcodes with exactly one inline operand (a local/global index).
        case OP.LOAD:
        case OP.STORE:
        case OP.TEE:
        case OP.GLOBAL_GET:
        case OP.GLOBAL_SET:
          this.code.push(op, code[i++]!);
          break;
        // Zero-operand opcodes.
        default:
          this.code.push(op);
          break;
      }
    }
  }
}

/**
 * Maps an IR binop tag to a stack-VM opcode. Ops outside the production subset
 * throw — the not-yet-migrated boundary surfaces loudly rather than silently
 * mis-lowering. Each entry that grows here is a #1584 op-group migration the
 * VM must learn in lockstep.
 */
export function binopToOpcode(op: IrBinop): Opcode {
  switch (op) {
    case "f64.add":
      return OP.ADD;
    case "f64.sub":
      return OP.SUB;
    case "f64.mul":
      return OP.MUL;
    case "f64.div":
      return OP.DIV;
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
    case "f64.ne":
    case "i32.ne":
      return OP.CMP_NE;
    default:
      throw new Error(
        `bytecode: binop '${op}' not in the #1584 production subset ` +
          `(add/sub/mul/div + compares). Its op group has not migrated behind ` +
          `the BackendEmitter trait yet — see plan/issues/1584.`,
      );
  }
}

/** Maps an IR unop tag to a stack-VM opcode. Out-of-subset ops throw. */
export function unopToOpcode(op: IrUnop): Opcode {
  if (op === "f64.neg") return OP.NEG;
  throw new Error(`bytecode: unary '${op}' not in the #1584 production subset (f64.neg). ` + `See plan/issues/1584.`);
}
