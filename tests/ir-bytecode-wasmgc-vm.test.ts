import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { BytecodeEmitter, BytecodeSink, OP } from "../src/ir/backend/bytecode-emitter.js";
import { runSink } from "../src/ir/backend/bytecode-vm.js";
import { buildImports } from "../src/runtime.js";

// #1584 slice (b) — the Wasm-GC-native dispatch loop.
//
// #1715 proved the #1713 backend seam can target a bytecode stream run by a
// HOST-TS dispatch loop (triple equivalence: runSink == WasmGC-src == JS). This
// file proves slice (b)'s acceptance criterion from the #1584 contract (PR #955
// §"Slice (b)"): the dispatch loop, **compiled BY js2wasm to Wasm-GC**, runs the
// same bytecode and equals the TS-interpreted VM. That makes the equivalence a
// QUADRUPLE:
//
//     host-TS VM  ==  Wasm-GC-compiled VM  ==  WasmGC-compiled source  ==  JS
//     (runSink)       (compile(bytecode-vm.ts))  (compile(src))          (eval)
//
// Critically — per the contract's slice-(b) acceptance test #2 — the Wasm-GC VM
// arm compiles **the actual `src/ir/backend/bytecode-vm.ts` file**, not a hand-
// kept copy. `compileVmModule()` reads that file at test time and applies only
// the minimal mechanical transforms a "compile the dispatch loop itself" step
// needs (drop the host `import`, inline the `OP.*` numbers, drop the
// `BytecodeSink`-typed `runSink` helper which is out of the numeric subset, and
// append an in-module-build entry because `number[]` can't cross the export ABI
// — the #1700 gap). The dispatch-loop body itself is compiled verbatim, so if
// anyone edits `bytecode-vm.ts`, THIS test compiles the edited loop — there is
// no second copy to drift.
//
// Contract discipline (#1584 one-owner rule): the `OP` enum + `BytecodeSink` are
// owned by sdev-emitter in `bytecode-emitter.ts`; this slice imports them
// READ-ONLY. The bytecode for the VM arms is produced by the SAME
// `BytecodeEmitter` the #1715 proof uses. Encoding is the #1715 STACK machine
// (the contract's §1a staging note: build on stack first; the reg+acc flip is a
// later coordinated bump owned by slice (a)).

const E = new BytecodeEmitter();

const __dirname = dirname(fileURLToPath(import.meta.url));
const VM_FILE = resolve(__dirname, "../src/ir/backend/bytecode-vm.ts");

/**
 * Read the real `bytecode-vm.ts` and turn it into a self-contained module that
 * `compile()` can lower, WITHOUT copying the dispatch-loop body. The four
 * transforms are exactly what a "compile the dispatch loop itself" step needs;
 * none touches the loop logic:
 *   1. drop the `import` line — a compiled Wasm module has no host TS to import.
 *   2. inline `OP.NAME` -> its numeric value (from the imported enum) so the
 *      switch arms are integer-literal cases.
 *   3. drop `runSink` — it is typed against `BytecodeSink` (an object), outside
 *      the numeric subset; the VM entry under test is `runBytecode`.
 *   4. append an exported entry that builds `code` / `constPool` / `args`
 *      in-module (the #1700 export-ABI constraint: `number[]` can't be a param).
 */
function compileVmModule(
  entryParams: readonly string[],
  code: readonly number[],
  constPool: readonly number[],
  argInit: readonly string[],
): string {
  let src = readFileSync(VM_FILE, "utf8");
  // 1. drop every import line (host-only).
  src = src.replace(/^import\b[^\n]*\n/gm, "");
  // 2. inline OP.NAME numeric values.
  for (const [name, value] of Object.entries(OP)) {
    src = src.replaceAll(`OP.${name}`, String(value));
  }
  // 3. drop the runSink convenience (BytecodeSink-typed -> out of subset). It is
  //    the trailing exported helper; cut from its doc-comment to EOF.
  src = src.replace(/\/\*\* Convenience[\s\S]*$/m, "");
  // 4. append the in-module-build entry.
  const params = entryParams.map((p) => `${p}: number`).join(", ");
  const entry = `
export function run(${params}): number {
  const code: number[] = [${code.join(", ")}];
  const constPool: number[] = [${constPool.join(", ")}];
  const args: number[] = [${argInit.join(", ")}];
  return runBytecode(code, constPool, args);
}
`;
  return src + entry;
}

// ── Compile + run a WasmGC export taking only number params ────────────────
async function runWasm(src: string, fn: string, args: number[]): Promise<number> {
  const r = compile(src, { fileName: "vm.ts" });
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

describe("#1584 slice (b) — Wasm-GC-native dispatch loop (quadruple equivalence)", () => {
  // ── f(a, b) = a + b ───────────────────────────────────────────────────────
  it("arithmetic: host-VM == WasmGC-VM == WasmGC-src == JS for f(a,b)=a+b", async () => {
    const src = `export function f(a: number, b: number): number { return a + b; }`;
    const js = (a: number, b: number): number => a + b;

    const sink = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary("f64.add", s);
      E.emitReturn(s);
      return s;
    };
    const s0 = sink();
    const vmMod = compileVmModule(["a", "b"], s0.code, s0.constPool, ["a", "b"]);

    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      const expected = js(a, b);
      expect(runSink(sink(), [a, b])).toBe(expected);
      expect(await runWasm(vmMod, "run", [a, b])).toBe(expected);
      expect(await runWasm(src, "f", [a, b])).toBe(expected);
    }
  });

  // ── g(a) = { let x = a * 2; return x } (local + const + mul + store/load) ─
  it("local+mul: host-VM == WasmGC-VM == WasmGC-src == JS for g(a)={let x=a*2;return x}", async () => {
    const src = `export function g(a: number): number { let x = a * 2; return x; }`;
    const js = (a: number): number => {
      const x = a * 2;
      return x;
    };

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
    // args[0] = a (param), args[1] = x (declared local, zero-init)
    const vmMod = compileVmModule(["a"], s0.code, s0.constPool, ["a", "0"]);

    for (const a of [3, -4, 0, 1.5, 1000]) {
      const expected = js(a);
      expect(runSink(sink(), [a, 0])).toBe(expected);
      expect(await runWasm(vmMod, "run", [a])).toBe(expected);
      expect(await runWasm(src, "g", [a])).toBe(expected);
    }
  });

  // ── h(a, b) = a > 0 ? a + b : a - b (conditional branch + JZ/JMP) ─────────
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
    const vmMod = compileVmModule(["a", "b"], s0.code, s0.constPool, ["a", "b"]);

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

  // ── NEG + the remaining compare opcodes through the compiled VM ──────────
  // f/g/h don't hit NEG or CMP_LT/GE/LE/EQ; exercise them so the Wasm-GC
  // dispatch arm covers every opcode `bytecode-vm.ts` implements.
  it("WasmGC-VM covers NEG and all CMP_* opcodes", async () => {
    // k(a) = -a ; LOAD 0, NEG, RET
    const negSink = new BytecodeSink();
    E.emitLocalGet(0, negSink);
    E.emitUnary("f64.neg", negSink);
    E.emitReturn(negSink);
    const negMod = compileVmModule(["a"], negSink.code, negSink.constPool, ["a"]);
    for (const a of [3, -4, 0, 1.5]) {
      expect(runSink(negSink, [a])).toBe(-a);
      expect(await runWasm(negMod, "run", [a])).toBe(-a);
    }

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
      const mod = compileVmModule(["a", "b"], s.code, s.constPool, ["a", "b"]);
      for (const [a, b] of [
        [1, 2],
        [2, 2],
        [3, 2],
        [-1, -1],
      ]) {
        const expected = ref(a, b);
        expect(runSink(s, [a, b]), `host ${op}(${a},${b})`).toBe(expected);
        expect(await runWasm(mod, "run", [a, b]), `wasm ${op}(${a},${b})`).toBe(expected);
      }
    }
  });

  // ── Sanity: the host VM still rejects out-of-subset / malformed (as #1715) ─
  it("host VM rejects malformed + out-of-subset (unchanged from #1715)", () => {
    const s = new BytecodeSink();
    E.emitConst(1, s); // never RET → runs off the end
    expect(() => runSink(s, [])).toThrow(/unknown opcode/);
    expect(() => E.emitBinary("f64.div", s)).toThrow(/not supported in proof/);
  });
});
