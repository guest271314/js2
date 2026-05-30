import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { BytecodeEmitter, BytecodeSink } from "../src/ir/backend/bytecode-emitter.js";
import { runSink } from "../src/ir/backend/bytecode-vm.js";

// #1715 → #1584 — bytecode-emitter triple-equivalence (backend-agnostic IR).
//
// The proof: the #1713 BackendEmitter seam can target a NON-Wasm execution model
// (a bytecode stream + dispatch loop) using the same primitive set and operand-
// evaluation contract that targets WasmGC. TRIPLE-EQUIVALENCE: for the same
// source function,
//
//     bytecode-interpreted result  ==  WasmGC-compiled result  ==  plain-JS result
//
// #1584 productionized the emitter: it now implements the `BackendEmitter<S>`
// trait surface (over a `BytecodeSink`) rather than the proof's bespoke API, so
// the SAME drive shape `lower.ts` uses for WasmGC drives it here. This test
// hand-lowers each function through that production trait surface exactly as
// `lower.ts` would: emit operand subtrees first, then the terminal-op primitive
// (the seam's operand-order contract); build each `if`-arm into its own sink via
// `newSink()`, then hand both to `emitIf` (mirroring how `lower.ts` builds
// `thenBody`/`elseBody` as separate buffers).
//
// Routing the REAL `lower.ts` through the bytecode sink (dropping the hand-
// lowering) is the #1584 (a0) follow-on: it threads the generic sink through
// `lower.ts` so the bytecode arm is produced by the production lowering. The
// emitter seam this test exercises is the foundation that step builds on.
//
// The WasmGC arm DOES go through the real compiler (`compile()`), so the
// equivalence pins the bytecode result against production WasmGC lowering.

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

/** Emit a numeric `const` through the production trait surface. */
function emitNumberConst(value: number, out: BytecodeSink): void {
  // The production emitConst takes an IR `const` instr; the f64 literal path is
  // a single CONST <poolIdx>, which is what these numeric proofs need.
  E.emitConst({ kind: "const", result: null, resultType: null, value: { kind: "f64", value } }, "proof", out);
}

describe("#1584 — bytecode-emitter triple equivalence (production trait surface)", () => {
  // ── f(a, b) = a + b ───────────────────────────────────────────────────────
  it("arithmetic: bytecode == WasmGC == JS for f(a,b)=a+b", async () => {
    const src = `export function f(a: number, b: number): number { return a + b; }`;
    const js = (a: number, b: number): number => a + b;
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s); // a
      E.emitLocalGet(1, s); // b
      E.emitBinary("f64.add", s);
      E.emitReturn(s);
      return s;
    };
    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      expect(runSink(lower(), [a, b])).toBe(js(a, b));
      expect(await runWasmGc(src, "f", [a, b])).toBe(js(a, b));
    }
  });

  // ── g(a) = { let x = a * 2; return x; }  (a local) ───────────────────────
  it("local + mul: bytecode == WasmGC == JS for g(a)={let x=a*2;return x}", async () => {
    const src = `export function g(a: number): number { let x = a * 2; return x; }`;
    const js = (a: number): number => {
      const x = a * 2;
      return x;
    };
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s); // a
      emitNumberConst(2, s); // 2
      E.emitBinary("f64.mul", s); // a * 2
      E.emitLocalSet(1, s); // x =
      E.emitLocalGet(1, s); // return x
      E.emitReturn(s);
      return s;
    };
    for (const a of [3, -4, 0, 1.5, 1000]) {
      expect(runSink(lower(), [a])).toBe(js(a));
      expect(await runWasmGc(src, "g", [a])).toBe(js(a));
    }
  });

  // ── h(a, b) = a > 0 ? a + b : a - b  (the conditional branch) ────────────
  it("conditional branch: bytecode == WasmGC == JS for h(a,b)=a>0?a+b:a-b", async () => {
    const src = `export function h(a: number, b: number): number { return a > 0 ? a + b : a - b; }`;
    const js = (a: number, b: number): number => (a > 0 ? a + b : a - b);
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      // cond: a > 0 — emitted into the outer sink, left on the stack for emitIf
      E.emitLocalGet(0, s);
      emitNumberConst(0, s);
      E.emitBinary("f64.gt", s);
      // then arm: a + b — built into its own sink (as lower.ts builds thenBody)
      const thenArm = E.newSink();
      E.emitLocalGet(0, thenArm);
      E.emitLocalGet(1, thenArm);
      E.emitBinary("f64.add", thenArm);
      // else arm: a - b
      const elseArm = E.newSink();
      E.emitLocalGet(0, elseArm);
      E.emitLocalGet(1, elseArm);
      E.emitBinary("f64.sub", elseArm);
      E.emitIf({ kind: "empty" }, thenArm, elseArm, s);
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
      expect(runSink(lower(), [a, b])).toBe(js(a, b));
      expect(await runWasmGc(src, "h", [a, b])).toBe(js(a, b));
    }
  });

  // ── The #1584 not-yet-migrated boundary: out-of-subset ops throw loudly ──
  it("out-of-subset ops throw with a clear #1584 message", () => {
    const s = new BytecodeSink();
    // js-bitwise / i32 logical families have not migrated behind the trait yet.
    expect(() => E.emitBinary("js.bitor", s)).toThrow(/not in the #1584 production subset/);
    expect(() => E.emitUnary("i32.eqz", s)).toThrow(/not in the #1584 production subset/);
    // The raw-Instr escape hatch rejects an Instr for an unrealized op family.
    expect(() => E.pushRaw(s, { op: "struct.get", typeIdx: 0, fieldIdx: 0 })).toThrow(
      /out of the #1584 production subset/,
    );
  });
});
