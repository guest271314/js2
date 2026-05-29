import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { BytecodeEmitter, BytecodeSink } from "../src/ir/backend/bytecode-emitter.js";
import { runSink } from "../src/ir/backend/bytecode-vm.js";

// #1715 — bytecode-emitter proof point (backend-agnostic IR).
//
// The proof: the #1713 BackendEmitter seam can target a NON-Wasm execution
// model (a bytecode stream + dispatch loop) using the same primitive set and
// operand-evaluation contract that targets WasmGC. We demonstrate it with a
// TRIPLE-EQUIVALENCE: for the same source function,
//
//     bytecode-interpreted result  ==  WasmGC-compiled result  ==  plain-JS result
//
// over the minimal IR subset (#1715 scope): arithmetic (add/sub/mul), local
// get/set, const, return, ONE conditional branch. The `BytecodeEmitter` here
// mirrors the `WasmGcEmitter` primitives but emits opcodes for the stack VM in
// `bytecode-vm.ts`.
//
// `lower.ts` is NOT invoked for the bytecode arm — building real IR from source
// drags in the whole front-end and is out of a throwaway proof's scope. Instead
// each function is hand-lowered below through the BytecodeEmitter exactly as
// `lower.ts` would drive it: the caller emits operand subtrees first, then calls
// the terminal-op primitive (the seam's operand-order contract). The WasmGC arm
// DOES go through the real compiler (`compile()`), so the equivalence pins the
// bytecode result against the production WasmGC lowering of the same program.

// ── WasmGC arm: compile the source and run the exported function ───────────
async function runWasmGc(src: string, fn: string, args: number[]): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  const f = (instance.exports as Record<string, (...a: number[]) => number>)[fn];
  return f(...args);
}

const E = new BytecodeEmitter();

describe("#1715 — bytecode-emitter proof point (triple equivalence)", () => {
  // ── f(a, b) = a + b  (pure arithmetic) ───────────────────────────────────
  it("arithmetic: bytecode == WasmGC == JS for f(a,b)=a+b", async () => {
    const src = `export function f(a: number, b: number): number { return a + b; }`;
    const js = (a: number, b: number): number => a + b;

    // hand-lower: locals[0]=a, locals[1]=b ; LOAD a, LOAD b, ADD, RET
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s); // operand a
      E.emitLocalGet(1, s); // operand b
      E.emitBinary("f64.add", s); // terminal op
      E.emitReturn(s);
      return s;
    };

    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      const bc = runSink(lower(), [a, b]);
      const wasm = await runWasmGc(src, "f", [a, b]);
      expect(bc).toBe(js(a, b));
      expect(wasm).toBe(js(a, b));
    }
  });

  // ── g(a) = { let x = a * 2; return x; }  (a local + mul) ──────────────────
  it("local + mul: bytecode == WasmGC == JS for g(a)={let x=a*2;return x}", async () => {
    const src = `export function g(a: number): number { let x = a * 2; return x; }`;
    const js = (a: number): number => {
      const x = a * 2;
      return x;
    };

    // hand-lower: locals[0]=a, locals[1]=x
    //   LOAD a, CONST 2, MUL, STORE x ; LOAD x, RET
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s); // a
      E.emitConst(2, s); // 2
      E.emitBinary("f64.mul", s); // a * 2
      E.emitLocalSet(1, s); // x = (top)
      E.emitLocalGet(1, s); // return x
      E.emitReturn(s);
      return s;
    };

    for (const a of [3, -4, 0, 1.5, 1000]) {
      const bc = runSink(lower(), [a]);
      const wasm = await runWasmGc(src, "g", [a]);
      expect(bc).toBe(js(a));
      expect(wasm).toBe(js(a));
    }
  });

  // ── h(a, b) = a > 0 ? a + b : a - b  (the ONE conditional branch) ─────────
  it("conditional branch: bytecode == WasmGC == JS for h(a,b)=a>0?a+b:a-b", async () => {
    const src = `export function h(a: number, b: number): number { return a > 0 ? a + b : a - b; }`;
    const js = (a: number, b: number): number => (a > 0 ? a + b : a - b);

    // hand-lower via the structured emitIf: cond (a>0), then (a+b), else (a-b).
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitIf(
        () => {
          E.emitLocalGet(0, s); // a
          E.emitConst(0, s); // 0
          E.emitBinary("f64.gt", s); // a > 0
        },
        () => {
          E.emitLocalGet(0, s); // a
          E.emitLocalGet(1, s); // b
          E.emitBinary("f64.add", s); // a + b
        },
        () => {
          E.emitLocalGet(0, s); // a
          E.emitLocalGet(1, s); // b
          E.emitBinary("f64.sub", s); // a - b
        },
        s,
      );
      E.emitReturn(s);
      return s;
    };

    for (const [a, b] of [
      [5, 3], // then-arm
      [-2, 7], // else-arm
      [0, 9], // boundary → else (0 > 0 is false)
      [1.5, -0.5],
      [-100, -1],
    ]) {
      const bc = runSink(lower(), [a, b]);
      const wasm = await runWasmGc(src, "h", [a, b]);
      expect(bc).toBe(js(a, b));
      expect(wasm).toBe(js(a, b));
    }
  });

  // ── Sanity: the VM rejects a malformed (RET-less) stream loudly ──────────
  // Running off the end of the code array reads `undefined` as the next opcode,
  // which the dispatch switch rejects — a clean failure rather than a hang.
  it("VM rejects a malformed (RET-less) stream", () => {
    const s = new BytecodeSink();
    E.emitConst(1, s); // push, never RET → runs off the end
    expect(() => runSink(s, [])).toThrow(/unknown opcode/);
  });

  // ── The #1715 finding, encoded as an assertion: the emitter rejects ──────
  // out-of-subset ops rather than silently mis-lowering them.
  it("out-of-subset ops throw not-supported-in-proof", () => {
    const s = new BytecodeSink();
    expect(() => E.emitBinary("f64.div", s)).toThrow(/not supported in proof/);
    expect(() => E.emitUnary("i32.eqz", s)).toThrow(/not supported in proof/);
  });
});
