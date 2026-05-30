import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { BytecodeEmitter, BytecodeSink, OP } from "../src/ir/backend/bytecode-emitter.js";
import {
  BYTECODE_VM_DISPATCH_SRC,
  VM_ERR_BAD_OPCODE,
  VM_ERR_STEP_BUDGET,
  buildBytecodeVmModule,
} from "../src/ir/backend/bytecode-vm-source.js";
import { runSink } from "../src/ir/backend/bytecode-vm.js";
import { buildImports } from "../src/runtime.js";

// #1584 — Wasm-GC-native dispatch loop (the VM slice).
//
// #1715 proved the #1713 backend seam can target a bytecode stream run by a
// dispatch loop written in HOST TypeScript. This file proves the OTHER half of
// #1584's claim: the dispatch loop, compiled BY js2wasm to Wasm-GC, runs the
// same bytecode and produces the same result. So we extend #1715's triple to a
// QUADRUPLE equivalence, for the same source function:
//
//     host-TS VM  ==  Wasm-GC-compiled VM  ==  WasmGC-compiled source  ==  JS
//     (runSink)       (compile(vmModule))      (compile(src))             (eval)
//
//   * host-TS VM        — `runSink` over the emitter's opcode stream (#1715).
//   * Wasm-GC VM        — `bytecode-vm-source.ts` compiled via real compile(),
//                         executing the SAME opcode stream in-module.
//   * WasmGC source     — the original TS function compiled via real compile()
//                         (the production AOT lowering, pins the bytecode result
//                         against the WasmGC backend, exactly as #1715 did).
//   * JS                — the reference semantics.
//
// The bytecode stream for both VM arms is produced by the SAME `BytecodeEmitter`
// the #1715 proof uses (contract discipline: we consume it read-only). The arms
// are hand-lowered exactly as `lower.ts` would drive the emitter (operands
// first, then the terminal op) — wiring real `lower.ts` to a generic sink is
// the emitter slice's job (#1584 task; see bytecode-emitter.ts header), not the
// VM's.

const E = new BytecodeEmitter();

// ── Compile + run a WasmGC export taking only number params ────────────────
async function runWasm(src: string, fn: string, args: number[]): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const withExports = imports as { setExports?: (e: unknown) => void };
  if (typeof withExports.setExports === "function") {
    withExports.setExports(instance.exports);
  }
  const f = (instance.exports as Record<string, (...a: number[]) => number>)[fn];
  return f(...args);
}

describe("#1584 — Wasm-GC-native dispatch loop (quadruple equivalence)", () => {
  // ── Contract alignment: the VM source's opcode literals == the OP enum ────
  // The VM source restates the opcode numbers inline (a compiled Wasm module
  // can't import the host enum). If the emitter changes an opcode value, this
  // fails loudly — the intended early warning per the one-owner contract.
  it("VM source opcode literals match the OP enum (contract pin)", () => {
    const want: Record<string, number> = {
      OP_CONST: OP.CONST,
      OP_LOAD: OP.LOAD,
      OP_STORE: OP.STORE,
      OP_ADD: OP.ADD,
      OP_SUB: OP.SUB,
      OP_MUL: OP.MUL,
      OP_CMP_GT: OP.CMP_GT,
      OP_CMP_LT: OP.CMP_LT,
      OP_CMP_GE: OP.CMP_GE,
      OP_CMP_LE: OP.CMP_LE,
      OP_CMP_EQ: OP.CMP_EQ,
      OP_NEG: OP.NEG,
      OP_JZ: OP.JZ,
      OP_JMP: OP.JMP,
      OP_RET: OP.RET,
    };
    for (const [name, value] of Object.entries(want)) {
      const re = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+);`);
      const m = BYTECODE_VM_DISPATCH_SRC.match(re);
      expect(m, `VM source must declare ${name}`).not.toBeNull();
      expect(Number(m![1]), `${name} literal must equal OP.${name.slice(3)}`).toBe(value);
    }
  });

  // ── f(a, b) = a + b ───────────────────────────────────────────────────────
  it("arithmetic: host-VM == WasmGC-VM == WasmGC-src == JS for f(a,b)=a+b", async () => {
    const src = `export function f(a: number, b: number): number { return a + b; }`;
    const js = (a: number, b: number): number => a + b;

    // hand-lower: LOAD 0, LOAD 1, ADD, RET
    const sink = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary("f64.add", s);
      E.emitReturn(s);
      return s;
    };
    const s0 = sink();
    const vmMod = buildBytecodeVmModule("run", ["a", "b"], s0.code, s0.constPool, ["a", "b"]);

    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      const expected = js(a, b);
      const hostVm = runSink(sink(), [a, b]);
      const wasmVm = await runWasm(vmMod, "run", [a, b]);
      const wasmSrc = await runWasm(src, "f", [a, b]);
      expect(hostVm).toBe(expected);
      expect(wasmVm).toBe(expected);
      expect(wasmSrc).toBe(expected);
    }
  });

  // ── g(a) = { let x = a * 2; return x } (local + const + mul + store/load) ─
  it("local+mul: host-VM == WasmGC-VM == WasmGC-src == JS for g(a)={let x=a*2;return x}", async () => {
    const src = `export function g(a: number): number { let x = a * 2; return x; }`;
    const js = (a: number): number => {
      const x = a * 2;
      return x;
    };

    // hand-lower: LOAD 0, CONST 2, MUL, STORE 1, LOAD 1, RET (locals: [a, x])
    const sink = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitConst(2, s);
      E.emitBinary("f64.mul", s);
      E.emitLocalSet(1, s);
      E.emitLocalGet(1, s);
      E.emitReturn(s);
      return s;
    };
    const s0 = sink();
    // locals[0] = a (param), locals[1] = x (declared, zero-init)
    const vmMod = buildBytecodeVmModule("run", ["a"], s0.code, s0.constPool, ["a", "0"]);

    for (const a of [3, -4, 0, 1.5, 1000]) {
      const expected = js(a);
      expect(runSink(sink(), [a, 0])).toBe(expected);
      expect(await runWasm(vmMod, "run", [a])).toBe(expected);
      expect(await runWasm(src, "g", [a])).toBe(expected);
    }
  });

  // ── h(a, b) = a > 0 ? a + b : a - b (the conditional branch + JZ/JMP) ─────
  it("branch: host-VM == WasmGC-VM == WasmGC-src == JS for h(a,b)=a>0?a+b:a-b", async () => {
    const src = `export function h(a: number, b: number): number { return a > 0 ? a + b : a - b; }`;
    const js = (a: number, b: number): number => (a > 0 ? a + b : a - b);

    const sink = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitIf(
        () => {
          E.emitLocalGet(0, s);
          E.emitConst(0, s);
          E.emitBinary("f64.gt", s);
        },
        () => {
          E.emitLocalGet(0, s);
          E.emitLocalGet(1, s);
          E.emitBinary("f64.add", s);
        },
        () => {
          E.emitLocalGet(0, s);
          E.emitLocalGet(1, s);
          E.emitBinary("f64.sub", s);
        },
        s,
      );
      E.emitReturn(s);
      return s;
    };
    const s0 = sink();
    const vmMod = buildBytecodeVmModule("run", ["a", "b"], s0.code, s0.constPool, ["a", "b"]);

    for (const [a, b] of [
      [5, 3],
      [-2, 7],
      [0, 9], // boundary → else
      [1.5, -0.5],
      [-100, -1],
    ]) {
      const expected = js(a, b);
      expect(runSink(sink(), [a, b])).toBe(expected);
      expect(await runWasm(vmMod, "run", [a, b])).toBe(expected);
      expect(await runWasm(src, "h", [a, b])).toBe(expected);
    }
  });

  // ── NEG + the remaining compare opcodes, exercised through the compiled VM ─
  // These opcodes are in the subset but not hit by f/g/h; cover them directly
  // so the Wasm-GC dispatch arm is exercised end-to-end for every opcode.
  it("WasmGC-VM covers NEG and all CMP_* opcodes", async () => {
    // k(a) = -(a)        ; LOAD 0, NEG, RET
    const negSink = new BytecodeSink();
    E.emitLocalGet(0, negSink);
    E.emitUnary("f64.neg", negSink);
    E.emitReturn(negSink);
    const negMod = buildBytecodeVmModule("run", ["a"], negSink.code, negSink.constPool, ["a"]);
    for (const a of [3, -4, 0, 1.5]) {
      expect(runSink(negSink, [a])).toBe(-a);
      expect(await runWasm(negMod, "run", [a])).toBe(-a);
    }

    // For each compare op: cmp(a,b) = (a OP b) ? 1 : 0 ; LOAD 0, LOAD 1, CMP, RET
    const compares: Array<[Parameters<typeof E.emitBinary>[0], (a: number, b: number) => number]> = [
      ["f64.lt", (a, b) => (a < b ? 1 : 0)],
      ["f64.ge", (a, b) => (a >= b ? 1 : 0)],
      ["f64.le", (a, b) => (a <= b ? 1 : 0)],
      ["f64.eq", (a, b) => (a === b ? 1 : 0)],
    ];
    for (const [op, ref] of compares) {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary(op, s);
      E.emitReturn(s);
      const mod = buildBytecodeVmModule("run", ["a", "b"], s.code, s.constPool, ["a", "b"]);
      for (const [a, b] of [
        [1, 2],
        [2, 2],
        [3, 2],
        [-1, -1],
      ]) {
        const expected = ref(a, b);
        expect(runSink(s, [a, b]), `host VM ${op}(${a},${b})`).toBe(expected);
        expect(await runWasm(mod, "run", [a, b]), `wasm VM ${op}(${a},${b})`).toBe(expected);
      }
    }
  });

  // ── The compiled VM surfaces malformed streams as sentinels, not a hang ────
  // Standalone Wasm has no host exception to throw a string across, so the
  // Wasm-GC VM returns sentinel values (the host VM throws — both are a clean,
  // non-hanging failure). RET-less stream → runs off the end → bad-opcode
  // sentinel (reading past the array yields a value the switch rejects).
  it("WasmGC-VM returns the bad-opcode sentinel for an unknown opcode", async () => {
    // A single unknown opcode (99) then nothing.
    const mod = buildBytecodeVmModule("run", [], [99], [], []);
    expect(await runWasm(mod, "run", [])).toBe(VM_ERR_BAD_OPCODE);
  });

  it("WasmGC-VM returns the step-budget sentinel for an infinite loop", async () => {
    // JMP 0 forever (target index 0 = the JMP itself) → trips the step budget.
    const mod = buildBytecodeVmModule("run", [], [OP.JMP, 0], [], []);
    expect(await runWasm(mod, "run", [])).toBe(VM_ERR_STEP_BUDGET);
  });

  // ── Sanity: the host VM still rejects out-of-subset / malformed (as #1715) ─
  it("host VM rejects malformed + out-of-subset (unchanged from #1715)", () => {
    const s = new BytecodeSink();
    E.emitConst(1, s); // never RET → off the end
    expect(() => runSink(s, [])).toThrow(/unknown opcode/);
    expect(() => E.emitBinary("f64.div", s)).toThrow(/not supported in proof/);
  });
});
