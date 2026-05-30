// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1584 — PRODUCTION bytecode lowering driver. Walks the REAL `IrFunction` the
// front-end (`from-ast.ts`) builds from source and drives the
// {@link BytecodeEmitter} to emit a {@link BytecodeSink} opcode stream.
//
// ## What this productionizes (vs the #1715 proof)
//
// The #1715 proof drove the bytecode emitter from HAND-LOWERED IR written inline
// in the test. This driver drives the emitter from the SAME `IrFunction` the
// WasmGC backend (`lower.ts` → `WasmGcEmitter`) consumes. So the triple
// equivalence
//
//     bytecode(real IR)  ==  WasmGC(real IR)  ==  plain JS
//
// now pins the bytecode lowering against the production front-end, not a
// hand-transcription. THAT is the slice: moving from hand-lowered IR to real
// compiler IR through the same backend seam (#1713).
//
// ## Scope — the routed subset, mirrored from lower.ts
//
// This covers exactly the IR-node subset the #1713 `BackendEmitter` trait routes
// today (the subset whose terminal-op emission goes through `emitter.*` rather
// than an inline `out.push` in lower.ts): `const`, `binary`, `unary`, `select`,
// structured `if`, `global.get/set`, and the `return`/`br_if`/`br`/`unreachable`
// terminators. Any IR node OUTSIDE that subset (`call`, `object.*`, `box`,
// `try`, `forof.*`, the js-bitwise composite ops, closures, strings, …) throws a
// clear `not-in-#1584-subset` error — those op groups have NOT migrated behind
// the trait, so they cannot yet be lowered through a non-`Instr[]` sink. As
// #1584 migrates an op group, this driver grows a case for it in lockstep with
// the emitter + VM.
//
// ## SSA → stack emission (mirrors lower.ts's contract)
//
// lower.ts emits SSA values tree-style: a single-use value inlines at its use
// site; a multi-use value materialises into a Wasm local via `local.tee` on
// first use and becomes `local.get` thereafter. We mirror that exactly with the
// stack VM's TEE opcode + a per-value local slot, so operand-evaluation order
// and re-materialisation match the WasmGC lowering's observable behaviour. The
// #1584 subset is single-block (the structured `if`/`select` carry their own
// control flow), so cross-block materialisation — lower.ts's `crossBlock` /
// pre-terminator hoist — is not reachable here; if a multi-block shape arrives,
// the `br`/`br_if` cases below inline successor blocks the same way lower.ts
// does for its Phase-1-3 structured CFG.

import type { IrBlock, IrFunction, IrInstr, IrTerminator, IrValueId } from "../../nodes.js";
import { BytecodeEmitter } from "./emitter.js";
import { BytecodeSink, OP } from "./opcodes.js";

/** The compiled program for one IR function. */
export interface BytecodeProgram {
  readonly name: string;
  readonly code: readonly number[];
  readonly constPool: readonly number[];
  /** Parameter count — the VM seeds locals 0..paramCount-1 from `args`. */
  readonly paramCount: number;
}

function notInSubset(what: string, funcName: string): never {
  throw new Error(
    `bytecode lower: ${what} is not in the #1584 production subset (function ` +
      `'${funcName}'). Its IR-node group has not migrated behind the ` +
      `BackendEmitter trait yet — see plan/issues/1584.`,
  );
}

/**
 * Lower a real `IrFunction` (built by the front-end) to a bytecode program for
 * the #1584 production stack VM. Throws `not-in-#1584-subset` for any node the
 * routed subset does not cover. The {@link BytecodeEmitter} owns which opcode
 * each primitive emits; this driver owns operand order + SSA materialisation.
 */
export function lowerIrFunctionToBytecode(func: IrFunction): BytecodeProgram {
  if (func.blocks.length === 0) {
    throw new Error(`bytecode lower: function ${func.name} has no blocks`);
  }
  const E = new BytecodeEmitter();

  // ── index maps (mirrors lower.ts) ──────────────────────────────────────
  const paramIdx = new Map<IrValueId, number>();
  func.params.forEach((p, idx) => paramIdx.set(p.value, idx));

  // SSA def lookup, walking into `if`-arm buffers (the only nested-instr shape
  // in the subset) so a value defined inside an arm resolves at its use site.
  const defBy = new Map<IrValueId, IrInstr>();
  const registerDefs = (instr: IrInstr): void => {
    if (instr.result !== null) {
      if (defBy.has(instr.result)) {
        throw new Error(`bytecode lower: duplicate SSA def for ${instr.result} in ${func.name}`);
      }
      defBy.set(instr.result, instr);
    }
    if (instr.kind === "if") {
      for (const sub of instr.then) registerDefs(sub);
      for (const sub of instr.else) registerDefs(sub);
    }
  };
  for (const block of func.blocks) for (const instr of block.instrs) registerDefs(instr);

  // Use counts (multi-use ⇒ materialise to a local). Counts every operand
  // reference across instrs (and into if-arms / terminators).
  const useCount = new Map<IrValueId, number>();
  const bump = (v: IrValueId): void => {
    useCount.set(v, (useCount.get(v) ?? 0) + 1);
  };
  const countInstr = (instr: IrInstr): void => {
    switch (instr.kind) {
      case "const":
        break;
      case "binary":
        bump(instr.lhs);
        bump(instr.rhs);
        break;
      case "unary":
        bump(instr.rand);
        break;
      case "select":
        bump(instr.condition);
        bump(instr.whenTrue);
        bump(instr.whenFalse);
        break;
      case "global.get":
        break;
      case "global.set":
        bump(instr.value);
        break;
      case "if":
        bump(instr.cond);
        for (const s of instr.then) countInstr(s);
        for (const s of instr.else) countInstr(s);
        bump(instr.thenValue);
        bump(instr.elseValue);
        break;
      default:
        notInSubset(`instruction kind '${instr.kind}'`, func.name);
    }
  };
  const countTerm = (t: IrTerminator): void => {
    if (t.kind === "return") for (const v of t.values) bump(v);
    else if (t.kind === "br_if") bump(t.condition);
  };
  for (const block of func.blocks) {
    for (const instr of block.instrs) countInstr(instr);
    countTerm(block.terminator);
  }

  // Cross-arm materialisation hazard guard. The tee pattern materialises a
  // multi-use value into a local at its FIRST emitted use. If that first use is
  // INSIDE one `if` arm but the value is also read from the sibling arm (or
  // after the `if`), the tee runs only when that arm executes at runtime — so a
  // read on the other path sees an uninitialised local. lower.ts handles this
  // with cross-block pre-materialisation (`crossBlock`); the #1584 subset does
  // not yet replicate that hoist, so we DETECT the hazard and surface it as a
  // clear out-of-subset error rather than silently mis-lowering. A value is at
  // risk iff it is multi-use AND referenced from inside an if-arm while being
  // defined OUTSIDE that arm. (Params and single-use values are always safe.)
  const armReferenced = new Set<IrValueId>();
  const collectArmRefs = (instr: IrInstr): void => {
    if (instr.kind !== "if") return;
    const refsInArm = (sub: IrInstr): void => {
      switch (sub.kind) {
        case "binary":
          armReferenced.add(sub.lhs);
          armReferenced.add(sub.rhs);
          break;
        case "unary":
          armReferenced.add(sub.rand);
          break;
        case "select":
          armReferenced.add(sub.condition);
          armReferenced.add(sub.whenTrue);
          armReferenced.add(sub.whenFalse);
          break;
        case "global.set":
          armReferenced.add(sub.value);
          break;
        case "if":
          armReferenced.add(sub.cond);
          for (const s of sub.then) refsInArm(s);
          for (const s of sub.else) refsInArm(s);
          armReferenced.add(sub.thenValue);
          armReferenced.add(sub.elseValue);
          break;
        default:
          break;
      }
    };
    for (const s of instr.then) refsInArm(s);
    for (const s of instr.else) refsInArm(s);
    armReferenced.add(instr.thenValue);
    armReferenced.add(instr.elseValue);
    for (const s of instr.then) collectArmRefs(s);
    for (const s of instr.else) collectArmRefs(s);
  };
  for (const block of func.blocks) for (const instr of block.instrs) collectArmRefs(instr);
  for (const v of armReferenced) {
    // A value defined inside the SAME arm it is referenced from is single-arm
    // and safe (its tee dominates its later uses on that one path). The risk is
    // a value defined OUTSIDE any arm (entry-block / param) that is multi-use:
    // if not a param and multi-use, the tee-on-first-use is path-dependent.
    if (paramIdx.has(v)) continue;
    if ((useCount.get(v) ?? 0) > 1) {
      notInSubset(
        `cross-arm multi-use value ${v} (needs lower.ts-style cross-block ` +
          `pre-materialisation, not yet ported to the bytecode path)`,
        func.name,
      );
    }
  }

  // Local-slot allocation. Params occupy slots 0..N-1; each materialised
  // multi-use SSA value gets the next slot. (The VM lazily 0-inits any slot.)
  let nextLocal = func.params.length;
  const localIdx = new Map<IrValueId, number>();
  const slotFor = (v: IrValueId): number => {
    let idx = localIdx.get(v);
    if (idx === undefined) {
      idx = nextLocal++;
      localIdx.set(v, idx);
    }
    return idx;
  };
  const materialized = new Set<IrValueId>();

  // ── value / instr emission (mirrors lower.ts emitValue/emitInstrTree) ──
  const emitValue = (v: IrValueId, out: BytecodeSink): void => {
    const pi = paramIdx.get(v);
    if (pi !== undefined) {
      E.emitLocalGet(pi, out);
      return;
    }
    if (materialized.has(v)) {
      E.emitLocalGet(slotFor(v), out);
      return;
    }
    const d = defBy.get(v);
    if (!d) throw new Error(`bytecode lower: undefined SSA value ${v} in ${func.name}`);
    if ((useCount.get(v) ?? 0) > 1) {
      // Multi-use: emit the tree once, TEE into the value's slot (leaving it on
      // the stack for this first use), then later uses become local.get.
      emitInstrTree(d, out);
      E.emitLocalTee(slotFor(v), out);
      materialized.add(v);
      return;
    }
    emitInstrTree(d, out);
  };

  const emitInstrTree = (instr: IrInstr, out: BytecodeSink): void => {
    switch (instr.kind) {
      case "const":
        E.emitConst(instr, func.name, out);
        return;
      case "binary":
        emitValue(instr.lhs, out);
        emitValue(instr.rhs, out);
        E.emitBinary(instr.op, out); // throws for js.* composite ops (out of subset)
        return;
      case "unary":
        emitValue(instr.rand, out);
        E.emitUnary(instr.op, out);
        return;
      case "select":
        // Wasm select pops [v1, v2, cond] → v1 if cond!=0 else v2.
        emitValue(instr.whenTrue, out);
        emitValue(instr.whenFalse, out);
        emitValue(instr.condition, out);
        E.emitSelect(out);
        return;
      case "global.get":
        // The bytecode VM addresses globals by a small dense index. The real
        // resolver assigns global indices; for the #1584 subset we key off the
        // symbolic name's interned order — but since global *resolution* is a
        // resolver concern not yet threaded into the bytecode path, a global
        // reference is out-of-subset until that wiring lands.
        notInSubset("global access", func.name);
        return;
      case "global.set":
        notInSubset("global access", func.name);
        return;
      case "if": {
        // Structured short-circuiting if/else. Emit cond, then build each arm
        // into its own sink buffer (mirrors lower.ts building thenBody/elseBody
        // as separate Instr[]), then splice via emitIf's JZ/JMP backpatch.
        emitValue(instr.cond, out);
        const thenSink = new BytecodeSink();
        emitArmBody(instr.then, thenSink);
        emitValue(instr.thenValue, thenSink);
        const elseSink = new BytecodeSink();
        emitArmBody(instr.else, elseSink);
        emitValue(instr.elseValue, elseSink);
        E.emitIf(thenSink, elseSink, out);
        return;
      }
      default:
        notInSubset(`instruction kind '${instr.kind}'`, func.name);
    }
  };

  // Emit an if-arm body: materialise multi-use values defined in the arm at
  // their use site (the tee pattern handles it lazily, as in lower.ts).
  const emitArmBody = (body: readonly IrInstr[], out: BytecodeSink): void => {
    for (const bodyInstr of body) {
      if (bodyInstr.result === null) {
        // Side-effecting void instr — out of subset (no void primitives in the
        // #1584 numeric subset besides global.set, which is already gated).
        emitInstrTree(bodyInstr, out);
      }
      // Value-producing instrs emit lazily at their use site via emitValue.
    }
  };

  // ── block / terminator emission ────────────────────────────────────────
  const emitBlock = (block: IrBlock, out: BytecodeSink): void => {
    if (block.blockArgs.length !== 0) {
      throw new Error(`bytecode lower: block args not in #1584 subset (${func.name})`);
    }
    // Void-result instrs at statement position emit in order; value instrs are
    // pulled lazily through their uses (terminator / if-arms).
    for (const instr of block.instrs) {
      if (instr.result === null) emitInstrTree(instr, out);
    }
    const t = block.terminator;
    switch (t.kind) {
      case "return":
        for (const v of t.values) emitValue(v, out);
        E.emitReturn(out);
        return;
      case "br_if": {
        if (t.ifTrue.args.length !== 0 || t.ifFalse.args.length !== 0) {
          notInSubset("br_if with branch args", func.name);
        }
        const thenBlock = func.blocks[t.ifTrue.target as number];
        const elseBlock = func.blocks[t.ifFalse.target as number];
        if (!thenBlock || !elseBlock) {
          throw new Error(`bytecode lower: br_if target missing in ${func.name}`);
        }
        emitValue(t.condition, out);
        const thenSink = new BytecodeSink();
        emitBlock(thenBlock, thenSink);
        const elseSink = new BytecodeSink();
        emitBlock(elseBlock, elseSink);
        E.emitIf(thenSink, elseSink, out);
        return;
      }
      case "br": {
        if (t.branch.args.length !== 0) notInSubset("br with branch args", func.name);
        const target = func.blocks[t.branch.target as number];
        if (!target) throw new Error(`bytecode lower: br target missing in ${func.name}`);
        emitBlock(target, out);
        return;
      }
      case "unreachable":
        E.emitUnreachable(out);
        return;
    }
  };

  const sink = new BytecodeSink();
  emitBlock(func.blocks[0], sink);
  // A br_if-terminated entry leaves fallthrough after the structured if; a
  // trailing UNREACHABLE satisfies the "ends having produced the result shape"
  // contract (matches lower.ts's tail-unreachable for the same reason). RET is
  // a zero-operand opcode, so a stream that already ends in RET has it as its
  // final code entry — skip the redundant trap in that case.
  if (sink.code[sink.code.length - 1] !== OP.RET) {
    E.emitUnreachable(sink);
  }

  return {
    name: func.name,
    code: sink.code,
    constPool: sink.constPool,
    paramCount: func.params.length,
  };
}
