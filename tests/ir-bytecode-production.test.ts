import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { lowerIrFunctionToBytecode } from "../src/ir/backend/bytecode/lower-bytecode.js";
import { runBytecode } from "../src/ir/backend/bytecode/vm.js";

// #1584 — PRODUCTION bytecode emitter, driven by the REAL front-end IR.
//
// This is the productionization of the #1715 proof. Where #1715 HAND-LOWERED
// each function inline in the test (bypassing the front-end), this test runs
// the SAME `lowerFunctionAstToIr` the WasmGC backend consumes to build a real
// `IrFunction` from source, then lowers THAT through the production
// `BytecodeEmitter` → `BytecodeSink`. The triple equivalence
//
//     bytecode(real IR)  ==  WasmGC-compiled  ==  plain JS
//
// therefore pins the bytecode lowering against the production front-end IR, not
// a transcription. That is the slice: real lower.ts-shaped IR → generic sink.

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

// ── Bytecode arm: parse → real IR → bytecode → run (NO hand-lowering) ──────
function lowerSourceToBytecode(src: string, fnName: string) {
  const sf = ts.createSourceFile("test.ts", src, ts.ScriptTarget.ES2022, true);
  let decl: ts.FunctionDeclaration | undefined;
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) decl = node;
  });
  if (!decl) throw new Error(`test: function ${fnName} not found in source`);
  const { main } = lowerFunctionAstToIr(decl, { funcName: fnName });
  return lowerIrFunctionToBytecode(main);
}

function runBytecodeFromSource(src: string, fnName: string, args: number[]): number {
  const prog = lowerSourceToBytecode(src, fnName);
  return runBytecode(prog.code, prog.constPool, args);
}

describe("#1584 — production bytecode emitter (triple equivalence, REAL front-end IR)", () => {
  // ── f(a, b) = a + b ───────────────────────────────────────────────────────
  it("arithmetic: bytecode(real IR) == WasmGC == JS for f(a,b)=a+b", async () => {
    const src = `export function f(a: number, b: number): number { return a + b; }`;
    const js = (a: number, b: number): number => a + b;
    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      const bc = runBytecodeFromSource(src, "f", [a, b]);
      const wasm = await runWasmGc(src, "f", [a, b]);
      expect(bc).toBe(js(a, b));
      expect(wasm).toBe(js(a, b));
    }
  });

  // ── g(a) = { let x = a * 2; return x; }  (a local, multi-use via tee) ─────
  it("local + mul: bytecode(real IR) == WasmGC == JS for g(a)={let x=a*2;return x}", async () => {
    const src = `export function g(a: number): number { let x = a * 2; return x; }`;
    const js = (a: number): number => {
      const x = a * 2;
      return x;
    };
    for (const a of [3, -4, 0, 1.5, 1000]) {
      const bc = runBytecodeFromSource(src, "g", [a]);
      const wasm = await runWasmGc(src, "g", [a]);
      expect(bc).toBe(js(a));
      expect(wasm).toBe(js(a));
    }
  });

  // ── h(a, b) = a > 0 ? a + b : a - b  (the conditional branch) ─────────────
  it("conditional: bytecode(real IR) == WasmGC == JS for h(a,b)=a>0?a+b:a-b", async () => {
    const src = `export function h(a: number, b: number): number { return a > 0 ? a + b : a - b; }`;
    const js = (a: number, b: number): number => (a > 0 ? a + b : a - b);
    for (const [a, b] of [
      [5, 3],
      [-2, 7],
      [0, 9],
      [1.5, -0.5],
      [-100, -1],
    ]) {
      const bc = runBytecodeFromSource(src, "h", [a, b]);
      const wasm = await runWasmGc(src, "h", [a, b]);
      expect(bc).toBe(js(a, b));
      expect(wasm).toBe(js(a, b));
    }
  });

  // ── More arithmetic: div + nested expression, still in-subset ─────────────
  it("nested arithmetic: bytecode(real IR) == WasmGC == JS for k(a,b)=(a+b)*(a-b)", async () => {
    const src = `export function k(a: number, b: number): number { return (a + b) * (a - b); }`;
    const js = (a: number, b: number): number => (a + b) * (a - b);
    for (const [a, b] of [
      [5, 3],
      [10, 2],
      [-4, 4],
      [1.5, 0.5],
    ]) {
      const bc = runBytecodeFromSource(src, "k", [a, b]);
      const wasm = await runWasmGc(src, "k", [a, b]);
      expect(bc).toBe(js(a, b));
      expect(wasm).toBe(js(a, b));
    }
  });

  // ── Out-of-subset node surfaces loudly (the not-yet-migrated boundary) ────
  it("rejects an out-of-subset op with a clear #1584 error", () => {
    // A JS bitwise op builds a valid `js.bitor` binary IR node (the front-end
    // accepts it), but its lowering is the multi-op ToInt32 scratch dance that
    // lives INLINE in lower.ts — it has NOT migrated behind the BackendEmitter
    // trait, so `binopToOpcode` rejects it. This is the not-yet-migrated
    // boundary surfacing as a clear error rather than a silent mis-lowering.
    const src = `export function usesBitwise(a: number): number { return a | 0; }`;
    expect(() => lowerSourceToBytecode(src, "usesBitwise")).toThrow(/not in the #1584 production subset/);
  });
});
