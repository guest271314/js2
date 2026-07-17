// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — the disassembler. Renders `pc: OpName a, b  ;; const` for a
// FuncMeta's bytecode. This is the debugging contract (doc §"Encoding": "no
// blind-in-Wasm debugging") and the readable oracle the fixture tests snapshot.
//
// The decode here is the reference for the base-word layout and the trailing-word
// conventions (WIDE operand, CallBuiltin argc, jump target) — it MUST stay in
// lockstep with the encoder and the loop.

import { BUILTIN_NAMES, OP_INFO, OP_MASK, OperandForm, WIDE_FLAG } from "./opcodes.js";
import { EXN_ROW, type FuncMeta, type JSValue } from "./types.js";

/** One decoded instruction: its opcode, operands, and the PC just after it. */
export interface DecodedInstr {
  pc: number;
  op: number;
  name: string;
  form: number;
  /** Primary operand (register / const index / jump target / builtin id). */
  a: number;
  /** Secondary operand (register / argc), or -1 when the form has none. */
  b: number;
  /** CallBuiltin's argc trailing word, or -1. */
  argc: number;
  /** PC of the next instruction. */
  next: number;
}

/** Decode the single instruction at `pc` in `code`. */
export function decodeInstr(code: number[], pc: number): DecodedInstr {
  const word = code[pc]!;
  const op = word & OP_MASK;
  const wide = (word & WIDE_FLAG) !== 0;
  const info = OP_INFO[op];
  const packedA = (word >>> 8) & 0xfff;
  const packedB = (word >>> 20) & 0xfff;
  let a = packedA;
  let b = -1;
  let argc = -1;
  let next = pc + 1;

  if (info === undefined) {
    return { pc, op, name: `?op${op}`, form: -1, a: packedA, b: packedB, argc: -1, next: pc + 1 };
  }

  switch (info.form) {
    case OperandForm.None:
      break;
    case OperandForm.RegA:
    case OperandForm.ConstA:
      if (wide) {
        a = code[next]!;
        next += 1;
      }
      break;
    case OperandForm.RegAB:
      b = packedB;
      break;
    case OperandForm.ConstAregB:
      b = packedB;
      if (wide) {
        a = code[next]!;
        next += 1;
      }
      break;
    case OperandForm.Target:
      // Always WIDE: the absolute target is the trailing word.
      a = code[next]!;
      next += 1;
      break;
    case OperandForm.RegAcountB:
      b = packedB;
      break;
    case OperandForm.Builtin:
      b = packedB;
      argc = code[next]!;
      next += 1;
      break;
    default:
      break;
  }

  return { pc, op, name: info.name, form: info.form, a, b, argc, next };
}

/** Render one decoded instruction's operand text (without the pc/opcode prefix). */
function renderOperands(d: DecodedInstr, consts: JSValue[]): string {
  switch (d.form) {
    case OperandForm.None:
      return "";
    case OperandForm.RegA:
      return `r${d.a}`;
    case OperandForm.RegAB:
      return `r${d.a}, r${d.b}`;
    case OperandForm.ConstA:
      return `c${d.a}  ;; ${constRepr(consts, d.a)}`;
    case OperandForm.ConstAregB:
      return `c${d.a}, r${d.b}  ;; ${constRepr(consts, d.a)}`;
    case OperandForm.Target:
      return `@${d.a}`;
    case OperandForm.RegAcountB:
      return `r${d.a}, #${d.b}`;
    case OperandForm.Builtin:
      return `%${BUILTIN_NAMES[d.a] ?? d.a}%  r${d.b}, #${d.argc}`;
    default:
      return `<a=${d.a} b=${d.b}>`;
  }
}

/** A short, stable one-line repr of a constant-pool entry. */
export function constRepr(consts: JSValue[], idx: number): string {
  if (idx < 0 || idx >= consts.length) return `<const #${idx} out of range>`;
  const v = consts[idx];
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "number" || t === "boolean") return String(v);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  // A nested FuncMeta prints as its name for readability.
  if (v && typeof v === "object" && "code" in v && "regCount" in v) {
    const nm = (v as { name?: JSValue }).name;
    return `<FuncMeta ${typeof nm === "string" && nm.length > 0 ? nm : "(anonymous)"}>`;
  }
  return `<${t}>`;
}

/** Disassemble a whole {@link FuncMeta} into a multi-line string. */
export function disassemble(meta: FuncMeta): string {
  const lines: string[] = [];
  const nm = typeof meta.name === "string" && meta.name.length > 0 ? meta.name : "(anonymous)";
  lines.push(
    `; FuncMeta ${nm}  regCount=${meta.regCount} paramCount=${meta.paramCount} flags=0b${meta.flags.toString(2)}`,
  );
  const code = meta.code;
  let pc = 0;
  const n = code.length;
  for (;;) {
    if (pc >= n) break;
    const d = decodeInstr(code, pc);
    const operands = renderOperands(d, meta.consts);
    const pcCol = String(pc).padStart(4, " ");
    lines.push(operands.length > 0 ? `${pcCol}: ${d.name} ${operands}` : `${pcCol}: ${d.name}`);
    if (d.next <= pc) {
      // Defensive: a malformed/zero-width decode would loop forever.
      lines.push(`${pcCol}: <decode did not advance — aborting>`);
      break;
    }
    pc = d.next;
  }
  // Render the exception table, if any.
  if (meta.exnTable !== null && meta.exnTable.length > 0) {
    lines.push("; exn-table [startPC, endPC) -> handlerPC (reg)");
    const t = meta.exnTable;
    let i = 0;
    for (;;) {
      if (i + EXN_ROW > t.length) break;
      lines.push(`;   [${t[i]}, ${t[i + 1]}) -> ${t[i + 2]} (r${t[i + 3]})`);
      i += EXN_ROW;
    }
  }
  return lines.join("\n");
}
