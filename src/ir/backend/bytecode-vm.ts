// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Bytecode dispatch loop (#1715) — the TypeScript stack VM that executes the
// opcode stream {@link BytecodeEmitter} produces.
//
// Written in plain TypeScript ON PURPOSE: #1584's eventual design is to compile
// the dispatch loop itself with js2wasm, so the loop must be expressible in the
// language subset js2wasm already handles (numbers, locals, a switch, a loop,
// arrays-as-stack). This proof keeps it to that subset so the #1584 follow-up
// can lift it without a rewrite.
//
// Execution model: a stack machine over `number[]`. Locals are an array (args
// then declared locals); the operand stack is a `number[]`. Booleans are 1.0 /
// 0.0 (matching the emitter's CMP_* ops and JS truthiness for the JZ branch).
// All values are JS numbers (f64) — the #1715 subset is numeric only.

import { OP, type BytecodeSink } from "./bytecode-emitter.js";

/**
 * Run a compiled bytecode program.
 *
 * @param code      flat opcode + inline-operand stream (`sink.code`)
 * @param constPool f64 immediates referenced by `OP.CONST <poolIdx>` (`sink.constPool`)
 * @param args      initial values of locals 0..n-1 (the function parameters);
 *                  any higher local index used by STORE/LOAD is lazily 0-init.
 * @returns the number left on the stack by `OP.RET`
 */
export function runBytecode(code: readonly number[], constPool: readonly number[], args: readonly number[]): number {
  const locals: number[] = args.slice();
  const stack: number[] = [];
  let pc = 0;

  // Bounded loop guard — proof programs are tiny + non-looping; this only trips
  // on a malformed stream (missing RET / bad backpatch), turning a hang into a
  // clear failure for the test.
  let steps = 0;
  const MAX_STEPS = 1_000_000;

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
      case OP.NEG:
        stack.push(-stack.pop()!);
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
      default:
        throw new Error(`bytecode-vm: unknown opcode ${op} at pc ${pc - 1}`);
    }
  }
}

/** Convenience: run a {@link BytecodeSink}'s program. */
export function runSink(sink: BytecodeSink, args: readonly number[]): number {
  return runBytecode(sink.code, sink.constPool, args);
}
