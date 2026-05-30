// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1584 — PRODUCTION bytecode dispatch loop (stack VM). Executes the opcode
// stream the {@link BytecodeEmitter} produces, driven by the real `lower.ts`
// IR via `lower-bytecode.ts`.
//
// This is the reference dispatch loop for the #1584 production subset. It is
// written in plain TypeScript ON PURPOSE — #1584's design compiles the dispatch
// loop itself with js2wasm (numbers, locals, a switch, a loop, arrays-as-stack),
// so the loop stays inside that subset and the follow-up can lift it without a
// rewrite. The sdev-vm track owns the Wasm-GC-compiled VM that this mirrors;
// both consume `opcodes.ts` read-only as the single opcode contract.
//
// Execution model (stack machine over `number[]`): locals are an array (args
// then declared locals); the operand stack is a `number[]`. Booleans are
// 1.0 / 0.0 (matching the emitter's CMP_* ops + JS truthiness for JZ). All
// values are JS numbers (f64) — the #1584 production subset is numeric.

import { OP } from "./opcodes.js";

/** A linked global-environment closure the VM reads/writes for GLOBAL_GET/SET. */
export interface BytecodeGlobals {
  get(index: number): number;
  set(index: number, value: number): void;
}

/**
 * Run a compiled bytecode program.
 *
 * @param code      flat opcode + inline-operand stream (`sink.code`)
 * @param constPool f64 immediates referenced by `OP.CONST <poolIdx>` (`sink.constPool`)
 * @param args      initial values of locals 0..n-1 (function parameters); any
 *                  higher local index used by STORE/LOAD is lazily 0-init.
 * @param globals   optional global environment for GLOBAL_GET/SET. A program
 *                  that touches globals without one throws (a malformed link).
 * @returns the number left on the stack by `OP.RET`
 */
export function runBytecode(
  code: readonly number[],
  constPool: readonly number[],
  args: readonly number[],
  globals?: BytecodeGlobals,
): number {
  const locals: number[] = args.slice();
  const stack: number[] = [];
  let pc = 0;

  // Bounded loop guard. The #1584 production subset is non-looping (the loop
  // op groups have not migrated behind the trait yet), so this only trips on a
  // malformed stream (missing RET / bad backpatch), turning a hang into a clear
  // failure. Raise the budget when loop opcodes join the subset.
  let steps = 0;
  const MAX_STEPS = 10_000_000;

  for (;;) {
    if (++steps > MAX_STEPS) throw new Error("bytecode-vm: step budget exceeded (malformed program?)");
    const op = code[pc++];
    switch (op) {
      case OP.CONST:
        stack.push(constPool[code[pc++]!]!);
        break;
      case OP.LOAD:
        stack.push(locals[code[pc++]!] ?? 0);
        break;
      case OP.STORE: {
        const idx = code[pc++]!;
        locals[idx] = stack.pop()!;
        break;
      }
      case OP.TEE: {
        const idx = code[pc++]!;
        locals[idx] = stack[stack.length - 1]!;
        break;
      }
      case OP.GLOBAL_GET: {
        const idx = code[pc++]!;
        if (!globals) throw new Error("bytecode-vm: GLOBAL_GET without a global environment");
        stack.push(globals.get(idx));
        break;
      }
      case OP.GLOBAL_SET: {
        const idx = code[pc++]!;
        if (!globals) throw new Error("bytecode-vm: GLOBAL_SET without a global environment");
        globals.set(idx, stack.pop()!);
        break;
      }
      case OP.ADD: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a + b);
        break;
      }
      case OP.SUB: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a - b);
        break;
      }
      case OP.MUL: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a * b);
        break;
      }
      case OP.DIV: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a / b);
        break;
      }
      case OP.CMP_GT: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a > b ? 1 : 0);
        break;
      }
      case OP.CMP_LT: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a < b ? 1 : 0);
        break;
      }
      case OP.CMP_GE: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a >= b ? 1 : 0);
        break;
      }
      case OP.CMP_LE: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a <= b ? 1 : 0);
        break;
      }
      case OP.CMP_EQ: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a === b ? 1 : 0);
        break;
      }
      case OP.CMP_NE: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a !== b ? 1 : 0);
        break;
      }
      case OP.NEG:
        stack.push(-stack.pop()!);
        break;
      case OP.SELECT: {
        // Wasm `select`: pops [a, b, cond] → a if cond != 0 else b.
        const cond = stack.pop()!;
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(cond !== 0 ? a : b);
        break;
      }
      case OP.DROP:
        stack.pop();
        break;
      case OP.JZ: {
        const target = code[pc++]!;
        if (stack.pop() === 0) pc = target;
        break;
      }
      case OP.JMP:
        pc = code[pc++]!;
        break;
      case OP.RET:
        return stack.pop()!;
      case OP.UNREACHABLE:
        throw new Error(`bytecode-vm: reached UNREACHABLE at pc ${pc - 1}`);
      default:
        throw new Error(`bytecode-vm: unknown opcode ${op} at pc ${pc - 1}`);
    }
  }
}
