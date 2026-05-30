// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Wasm-GC-native bytecode dispatch loop (#1584, the VM slice of Phase 1).
//
// ## What this is — and how it differs from `bytecode-vm.ts`
//
// `bytecode-vm.ts` (#1715) is the dispatch loop running as **host TypeScript**:
// the proof that the #1713 backend seam can target a non-Wasm execution model.
// This module is the **next half of #1584's claim**: the dispatch loop running
// as **compiled Wasm-GC** — the interpreter itself lowered through js2wasm, not
// interpreted by the host. #1584's architecture states it explicitly:
//
//   > Component 3 (Dispatch loop): a TypeScript function … itself compiled by
//   > js2wasm to Wasm-GC … so the generated code avoids interpreter-level boxing.
//
// The deliverable here is the **VM source text in the js2wasm-compilable
// subset**, plus the proof (in `tests/ir-bytecode-wasmgc-vm.test.ts`) that
// compiling it through the real `compile()` produces a Wasm-GC module whose
// execution matches the host-TS VM, the WasmGC-compiled source, and plain JS —
// a *quadruple* equivalence extending #1715's triple.
//
// ## Why the VM lives as a string (and not as a normal `.ts` module compiled
//    by tsc into the build)
//
// js2wasm consumes **source text** (`compile(src)`), so the artifact a
// "compile the dispatch loop with js2wasm" step needs is the *source* of the
// loop, not its host-executed form. Holding it as a string constant lets the
// test feed it straight to `compile()` with zero front-end plumbing, exactly
// the way #1584 Phase 1 will eventually link `runtime/parser.wasm` + the
// interpreter module. The host-TS `runBytecode` in `bytecode-vm.ts` and this
// string are kept *semantically identical* (same opcodes, same stack machine,
// same JZ/JMP control flow) so the equivalence is meaningful: divergence
// between them is a real VM bug, not a fixture drift.
//
// ## The #1584-VM findings this slice banks (read before extending)
//
//  1. **The dispatch loop compiles to Wasm-GC today, unchanged in shape.** The
//     stack machine — `for(;;)` + `switch(op)` + operand `number[]` as the
//     value stack + a `locals` `number[]` + a `code`/`constPool` `number[]` —
//     is fully inside the subset js2wasm already lowers. No compiler change was
//     needed to run the interpreter as Wasm-GC. That is the load-bearing
//     greenlight for #1584 Component 3.
//
//  2. **The one boundary constraint is the export ABI, not the loop.** Passing
//     a `number[]` *as an exported-function parameter* hits the JS↔Wasm
//     marshalling gap (#1700: "type incompatibility when transforming from/to
//     JS"). The interpreter therefore takes its entry as **primitive args** and
//     **builds the `code` / `constPool` / `locals` arrays in-module** (see
//     `BYTECODE_VM_ENTRY_*`). This is not a workaround forced on the design —
//     it is how a real eval-entry behaves: the bytecode for a given dynamic
//     source is emitted into the module, and the entry seeds only the call
//     arguments. When #1700's array-ABI lands, a generic `run(code[],…)` export
//     becomes possible too; until then the in-module-build entry is the
//     contract.
//
//  3. **Encoding is a free choice below the seam (confirmed again here).** This
//     VM is a stack machine, matching `bytecode-vm.ts` and #1715's §6 finding.
//     #1584's eventual register+accumulator VM changes the *opcode encoding and
//     the dispatch body* but not the "interpreter-as-compiled-Wasm-GC" property
//     this slice proves. Swapping the encoding does not touch the host/Wasm
//     boundary contract established in (2).
//
// ## Contract discipline (#1584 one-owner rule)
//
// The opcode set + `BytecodeSink` shape are OWNED by the emitter slice
// (`bytecode-emitter.ts`). This module CONSUMES them read-only: it re-states
// the opcode *numeric values* inline in the VM source string (a compiled Wasm
// module cannot import a host TS enum), and the test asserts those literals
// equal the `OP` enum so the two never drift. If the opcode set changes, the
// assertion in the test fails loudly — the intended early-warning. This module
// does NOT edit `bytecode-emitter.ts`, `bytecode-vm.ts`, `lower.ts`, the
// `BackendEmitter` sink, or any default compile path.

import { OP } from "./bytecode-emitter.js";

/**
 * The dispatch loop, authored in the js2wasm-compilable subset, as source text
 * for `compile()`. Kept semantically identical to `runBytecode` in
 * `bytecode-vm.ts`.
 *
 * Notes on the subset choices (each verified to compile + run as Wasm-GC):
 *  - `for (;;)` with `switch (op)` dispatch and `break` per case.
 *  - operand stack + locals + code + const pool are all `number[]` built
 *    *inside* the module (see entry wrappers) — never crossing the export ABI.
 *  - `!` non-null assertions satisfy `noUncheckedIndexedAccess`; they compile
 *    to plain reads (js2wasm arrays are dense f64 arrays here).
 *  - booleans are 1.0 / 0.0, matching the emitter's CMP_* ops and the JZ test.
 *  - a bounded step budget turns a malformed (RET-less / bad-backpatch) stream
 *    into a sentinel return instead of a hang, mirroring the host VM's guard.
 *
 * The opcode literals below MUST equal the `OP` enum (asserted in the test).
 */
export const BYTECODE_VM_DISPATCH_SRC = `
// Opcodes — MUST match OP in bytecode-emitter.ts (asserted by the test).
const OP_CONST = 0;
const OP_LOAD = 1;
const OP_STORE = 2;
const OP_ADD = 3;
const OP_SUB = 4;
const OP_MUL = 5;
const OP_CMP_GT = 6;
const OP_CMP_LT = 7;
const OP_CMP_GE = 8;
const OP_CMP_LE = 9;
const OP_CMP_EQ = 10;
const OP_NEG = 11;
const OP_JZ = 12;
const OP_JMP = 13;
const OP_RET = 14;

// Sentinels for malformed streams — distinct from any real f64 result so the
// test can distinguish "ran off the end" / "unknown opcode" from a value.
const VM_ERR_STEP_BUDGET = -1000000001;
const VM_ERR_BAD_OPCODE = -1000000002;

// The dispatch loop. \`code\` + \`constPool\` + \`locals\` are dense f64 arrays.
// \`locals\` is pre-seeded with the function arguments (and zero-filled slots for
// any declared local the program STOREs into). Returns the number left on the
// stack by OP_RET.
function runBytecode(code: number[], constPool: number[], locals: number[]): number {
  const stack: number[] = [];
  let pc = 0;
  let steps = 0;
  for (;;) {
    steps = steps + 1;
    if (steps > 1000000) {
      return VM_ERR_STEP_BUDGET;
    }
    const op = code[pc]!;
    pc = pc + 1;
    switch (op) {
      case OP_CONST: {
        stack.push(constPool[code[pc]!]!);
        pc = pc + 1;
        break;
      }
      case OP_LOAD: {
        stack.push(locals[code[pc]!]!);
        pc = pc + 1;
        break;
      }
      case OP_STORE: {
        const idx = code[pc]!;
        pc = pc + 1;
        locals[idx] = stack.pop()!;
        break;
      }
      case OP_ADD: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a + b);
        break;
      }
      case OP_SUB: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a - b);
        break;
      }
      case OP_MUL: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a * b);
        break;
      }
      case OP_CMP_GT: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a > b ? 1 : 0);
        break;
      }
      case OP_CMP_LT: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a < b ? 1 : 0);
        break;
      }
      case OP_CMP_GE: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a >= b ? 1 : 0);
        break;
      }
      case OP_CMP_LE: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a <= b ? 1 : 0);
        break;
      }
      case OP_CMP_EQ: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a === b ? 1 : 0);
        break;
      }
      case OP_NEG: {
        const a = stack.pop()!;
        stack.push(-a);
        break;
      }
      case OP_JZ: {
        const target = code[pc]!;
        pc = pc + 1;
        if (stack.pop()! === 0) {
          pc = target;
        }
        break;
      }
      case OP_JMP: {
        pc = code[pc]!;
        break;
      }
      case OP_RET: {
        return stack.pop()!;
      }
      default: {
        return VM_ERR_BAD_OPCODE;
      }
    }
  }
}
`;

/**
 * Sentinel returns the compiled VM emits for malformed streams. Mirror of the
 * `VM_ERR_*` consts in {@link BYTECODE_VM_DISPATCH_SRC}; the test asserts the
 * compiled module returns these for the malformed / unknown-opcode cases (the
 * Wasm-GC analogue of the host VM's `throw`, since standalone Wasm has no host
 * exception to surface a thrown string).
 */
export const VM_ERR_STEP_BUDGET = -1000000001;
export const VM_ERR_BAD_OPCODE = -1000000002;

/**
 * Build a complete, compilable program: the dispatch loop plus an exported
 * entry that constructs the `code` / `constPool` / `locals` arrays in-module
 * (per finding #2 — arrays never cross the export ABI) and runs them.
 *
 * @param entryName  exported function name
 * @param params     entry parameter names (the runtime args, e.g. `["a","b"]`)
 * @param code       the opcode stream (`sink.code`) as an integer array literal
 * @param constPool  the f64 immediate pool (`sink.constPool`)
 * @param localInit  initial `locals` array contents, as source expressions
 *                   (e.g. `["a", "b", "0"]` seeds locals 0,1 from params and a
 *                   zeroed local slot 2). The caller mirrors how `lower.ts`
 *                   would lay out the frame: params first, then declared locals.
 * @returns full source text ready for `compile()`
 */
export function buildBytecodeVmModule(
  entryName: string,
  params: readonly string[],
  code: readonly number[],
  constPool: readonly number[],
  localInit: readonly string[],
): string {
  const paramList = params.map((p) => `${p}: number`).join(", ");
  const codeLit = `[${code.join(", ")}]`;
  const cpLit = `[${constPool.join(", ")}]`;
  const localsLit = `[${localInit.join(", ")}]`;
  return `${BYTECODE_VM_DISPATCH_SRC}
export function ${entryName}(${paramList}): number {
  const code: number[] = ${codeLit};
  const constPool: number[] = ${cpLit};
  const locals: number[] = ${localsLit};
  return runBytecode(code, constPool, locals);
}
`;
}

// Re-export the opcode set this module is pinned against, so consumers can read
// the contract from one import. (Read-only: owned by bytecode-emitter.ts.)
export { OP };
