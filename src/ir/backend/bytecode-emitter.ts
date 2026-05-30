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

import type { IrBinop, IrInstr, IrUnop } from "../nodes.js";
import type { BlockType, Instr } from "../types.js";
import type { BackendEmitter } from "./emitter.js";

// ── Opcodes ───────────────────────────────────────────────────────────────
// A flat `number[]` instruction stream. Each opcode is one int; inline operands
// (a local index, a constant-pool index, a jump target) are the ints that
// follow it. f64 immediates live in a side constant pool (see BytecodeSink) so
// the code array stays integer-only — the dispatch loop reads them by index.
export const OP = {
  // ── #1715 base (numeric values 0..14 FROZEN — VM + proof depend on them) ──
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
  // ── #1584 production additions (next free integers; additive, sdev-vm aligned) ──
  // Each entry grows the VM dispatch (slice b) in lockstep. STACK encoding for
  // the first increment per the #1584 contract §1a staging note; a later
  // reg+acc bump (slice a, coordinated with sdev-vm) changes operand layout +
  // VM model but not these names.
  DIV: 15, //   DIV                  ; pop b, pop a, push a / b
  CMP_NE: 16, // CMP_NE              ; pop b, pop a, push (a != b) ? 1 : 0
  TEE: 17, //   TEE <localIdx>       ; peek top -> frame.locals[localIdx] (leaves it on stack)
  GLOBAL_GET: 18, // GLOBAL_GET <gIdx> ; push globals[gIdx]
  GLOBAL_SET: 19, // GLOBAL_SET <gIdx> ; pop -> globals[gIdx]
  SELECT: 20, // SELECT              ; pop cond, pop b, pop a, push (cond != 0) ? a : b
  DROP: 21, //  DROP                 ; pop and discard
  UNREACHABLE: 22, // UNREACHABLE    ; trap (malformed / dead code path)
  // ── (a1) call family (#1584 §2a) — multi-function VM (program wrapper +
  // call-frame stack). Both mirror Wasm `call`/`call_ref` exactly: one inline
  // operand, args already on the stack (arg0 deepest), callee arity NOT inline
  // (read from the function-table entry). funcref ≡ f64(tableIndex), null ≡
  // f64(-1) (CALL_REF on -1 traps). See sdev-vm coordination + issue §2a.
  CALL: 23, //     CALL <funcIdx>     ; pop arity args, run functions[funcIdx], push result
  CALL_REF: 24, // CALL_REF <typeIdx> ; pop funcref(top)+arity args, run functions[idx], push result
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

  /**
   * #1584: append another sink's code at the current position, relocating its
   * internal jump targets into this sink's address space and remapping its
   * const-pool indices into this sink's pool. Used by the production
   * `BytecodeEmitter.emitIf` to splice already-lowered `if`-arm buffers (the
   * real `lower.ts` builds each arm into its own sink, exactly as it builds the
   * WasmGC `if`'s `then`/`else` as separate `Instr[]`). Arms must be
   * self-contained — an unpatched jump in a spliced arm is an internal error.
   */
  spliceArm(arm: BytecodeSink): void {
    const base = this.code.length;
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
          if (target < 0) {
            throw new Error("BytecodeSink.spliceArm: arm contains an unpatched jump (internal error)");
          }
          this.code.push(op, target + base);
          break;
        }
        // Single-inline-operand opcodes (a local / global / const / func /
        // type index). CALL <funcIdx> / CALL_REF <typeIdx> carry exactly one
        // inline operand (no relocation needed — function/type indices are
        // program-global, not arm-local like jump targets/const-pool).
        case OP.LOAD:
        case OP.STORE:
        case OP.TEE:
        case OP.GLOBAL_GET:
        case OP.GLOBAL_SET:
        case OP.CALL:
        case OP.CALL_REF:
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
      // Not-yet-migrated boundary: the op's family (js-bitwise, i32.and/or, …)
      // has not moved behind the BackendEmitter trait, so it has no bytecode
      // realization yet. Surface loudly rather than silently mis-lower.
      throw new Error(
        `BytecodeEmitter: binop '${op}' not in the #1584 production subset ` +
          `(add/sub/mul/div + compares). Its op family has not migrated behind ` +
          `the BackendEmitter trait yet — see plan/issues/1584 §2a.`,
      );
  }
}

/** Maps an IR unop to a stack-VM opcode. Out-of-subset unops throw. */
function unopToOpcode(op: IrUnop): Opcode {
  if (op === "f64.neg") return OP.NEG;
  throw new Error(
    `BytecodeEmitter: unary '${op}' not in the #1584 production subset (f64.neg). ` + `See plan/issues/1584 §2a.`,
  );
}

/**
 * #1584 PRODUCTION emitter. Implements the {@link BackendEmitter}<{@link
 * BytecodeSink}> trait surface so the REAL `lower.ts` drives it identically to
 * how it drives {@link WasmGcEmitter}<Instr[]> — same primitive set, same
 * caller-owns-operand-order contract, different execution model. (This
 * supersedes the #1715 proof's hand-driven emitter: the proof's thunked
 * `emitIf` is replaced by the trait's pre-built-arm `emitIf`, since real
 * `lower.ts` builds each arm into its own sink then hands them over.)
 *
 * STACK encoding for the first increment (contract §1a staging note). The opcode
 * set lives above (`OP`, the single source of truth the VM imports read-only);
 * this class only decides which opcode each primitive emits.
 */
export class BytecodeEmitter implements BackendEmitter<BytecodeSink> {
  /** Factory for a child sink — used by `lower.ts` to build `if`-arm buffers. */
  newSink(): BytecodeSink {
    return new BytecodeSink();
  }

  /**
   * The raw-`Instr` escape hatch (the #1584 contract §0a-1). `lower.ts` still
   * has ~119 inline `out.push({op})` sites for op families not yet migrated
   * behind the trait. On the WasmGC path those append to the `Instr[]`; on the
   * bytecode path they reach a node family with no opcode realization yet, so
   * this throws — surfacing the not-yet-migrated boundary loudly rather than
   * silently mis-lowering. As each op family migrates (§2a), its `lower.ts`
   * sites move from `pushRaw` to a typed emitter primitive + opcode.
   */
  pushRaw(_out: BytecodeSink, instr: Instr): void {
    throw new Error(
      `BytecodeEmitter: raw Instr '${instr.op}' reached the bytecode sink — its ` +
        `op family has not migrated behind the BackendEmitter trait yet, so the ` +
        `function is out of the #1584 production subset. See plan/issues/1584 §2a.`,
    );
  }

  emitConst(instr: Extract<IrInstr, { kind: "const" }>, funcName: string, out: BytecodeSink): void {
    const v = instr.value;
    switch (v.kind) {
      case "i32":
      case "f32":
      case "f64":
        out.emit(OP.CONST, out.internConst(v.value));
        return;
      case "bool":
        out.emit(OP.CONST, out.internConst(v.value ? 1 : 0));
        return;
      case "i64":
      case "null":
      case "undefined":
        throw new Error(`BytecodeEmitter: const '${v.kind}' not in the #1584 numeric subset (${funcName})`);
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
   * then: Instr[], els: Instr[], out)`: the caller (real `lower.ts`) pre-lowers
   * each arm into its own {@link BytecodeSink} (via `newSink()`), then hands
   * them here. The cond value is already on the stack. The stack VM has no
   * structured block, so we lower to JZ/JMP + spliced arms with backpatched
   * targets:
   *
   *   <cond on stack>
   *   JZ elseLabel
   *   <then arm>
   *   JMP endLabel
   *   elseLabel: <else arm>
   *   endLabel:
   *
   * `blockType` is ignored (the bytecode VM is untyped over boxed values); it is
   * part of the trait signature for the WasmGC realization.
   */
  emitIf(_blockType: BlockType, then: BytecodeSink, els: BytecodeSink, out: BytecodeSink): void {
    const toElse = out.emitJumpPlaceholder(OP.JZ);
    out.spliceArm(then);
    const toEnd = out.emitJumpPlaceholder(OP.JMP);
    out.patch(toElse, out.here());
    out.spliceArm(els);
    out.patch(toEnd, out.here());
  }

  emitBr(_depth: number, _out: BytecodeSink): void {
    throw new Error("BytecodeEmitter: emitBr (multi-block CFG) not in the #1584 subset — see §2a control-flow family.");
  }

  emitBrIf(_depth: number, _out: BytecodeSink): void {
    throw new Error(
      "BytecodeEmitter: emitBrIf (multi-block CFG) not in the #1584 subset — see §2a control-flow family.",
    );
  }

  // ---- (a1) call family (#1584 §2a) — the first migrated family -----------
  // The args are already on the stack (caller-owns-operand-order, same as
  // WasmGC). `OP.CALL <funcIdx>` carries ONE inline operand; the callee arity
  // is NOT inline — the VM reads it from the function-table entry, mirroring
  // Wasm `call $f`. The multi-function VM (program wrapper + call-frame stack)
  // is sdev-vm's slice (see issue §2a + the locked contract).
  emitCall(funcIdx: number, out: BytecodeSink): void {
    out.emit(OP.CALL, funcIdx);
  }

  // `OP.CALL_REF <typeIdx>` — the funcref is already on top of the stack
  // (lower.ts pushes the callee/funcref LAST). funcref ≡ f64(tableIndex),
  // null ≡ f64(-1) which traps. `typeIdx` is informational (func-type id).
  emitCallRef(funcTypeIdx: number, out: BytecodeSink): void {
    out.emit(OP.CALL_REF, funcTypeIdx);
  }

  // ---- vec (array) primitives — out of the #1584 numeric subset -----------
  emitVecLen(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }
  emitVecDataPtr(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }
  emitElemGet(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }
}
