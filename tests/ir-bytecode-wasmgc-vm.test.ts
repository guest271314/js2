import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { BytecodeEmitter, BytecodeSink, OP } from "../src/ir/backend/bytecode-emitter.js";
import { type FuncEntry, type Program, runProgram, runSink } from "../src/ir/backend/bytecode-vm.js";
import type { BlockType } from "../src/ir/types.js";
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

// The production `BytecodeEmitter.emitConst` (per the #1713/#1584 trait, landed
// by the emitter slice) takes an IR `const` instr, not a bare number. For these
// numeric proofs the only path needed is the f64 literal → a single
// `CONST <poolIdx>`. This wrapper builds that IR const instr, mirroring the
// emitter slice's own `emitNumberConst` so both test suites drive the production
// signature identically. (Keeping this here, not in the VM, preserves the
// VM-owns-only-bytecode-vm.ts boundary.)
function emitNumberConst(value: number, out: BytecodeSink): void {
  E.emitConst(
    {
      kind: "const",
      result: null,
      resultType: null,
      value: { kind: "f64", value },
    },
    "proof",
    out,
  );
}

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
  // 2. inline OP.NAME numeric values. Replace LONGER names first: some opcode
  //    names are prefixes of others (e.g. `CALL` is a prefix of `CALL_REF`, and
  //    `GLOBAL_GET`/`GLOBAL_SET` share `GLOBAL`), and `replaceAll` on the prefix
  //    would corrupt the longer token (`OP.CALL_REF` -> `23_REF`). Descending
  //    name length guarantees the longest match is substituted first.
  for (const [name, value] of Object.entries(OP).sort((a, b) => b[0].length - a[0].length)) {
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

/**
 * Multi-function variant of {@link compileVmModule} (#1584 a1). Builds a
 * `Program` (function table + entry) in-module and calls `runProgram`, so the
 * compiled-VM arm exercises the CALL family. Same four transforms as
 * `compileVmModule`; the appended entry constructs each `FuncEntry` literal and
 * the `Program` wrapper inline (the #1700 export-ABI constraint: object/array
 * params can't cross the boundary, so the program is built inside the module).
 */
function compileProgramModule(
  entryParams: readonly string[],
  functions: ReadonlyArray<{
    code: readonly number[];
    constPool: readonly number[];
    arity: number;
    nLocals: number;
  }>,
  entry: number,
  argInit: readonly string[],
): string {
  let src = readFileSync(VM_FILE, "utf8");
  src = src.replace(/^import\b[^\n]*\n/gm, "");
  for (const [name, value] of Object.entries(OP).sort((a, b) => b[0].length - a[0].length)) {
    src = src.replaceAll(`OP.${name}`, String(value));
  }
  // Drop the trailing BytecodeSink-typed convenience helper (out of subset).
  src = src.replace(/\/\*\* Convenience[\s\S]*$/m, "");
  const params = entryParams.map((p) => `${p}: number`).join(", ");
  const fnLiterals = functions
    .map(
      (f) =>
        `{ code: [${f.code.join(", ")}], constPool: [${f.constPool.join(", ")}], arity: ${f.arity}, nLocals: ${f.nLocals} }`,
    )
    .join(",\n    ");
  const entrySrc = `
export function run(${params}): number {
  const functions: FuncEntry[] = [
    ${fnLiterals}
  ];
  const program: Program = { functions: functions, entry: ${entry} };
  const args: number[] = [${argInit.join(", ")}];
  return runProgram(program, args);
}
`;
  return src + entrySrc;
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
      emitNumberConst(2, s);
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
      // cond: a > 0 — emitted into the outer sink, left on the stack for emitIf.
      E.emitLocalGet(0, s);
      emitNumberConst(0, s);
      E.emitBinary("f64.gt", s);
      // then arm: a + b — pre-lowered into its own child sink, as lower.ts builds
      // each arm's body before handing it to the production emitIf.
      const thenArm = E.newSink();
      E.emitLocalGet(0, thenArm);
      E.emitLocalGet(1, thenArm);
      E.emitBinary("f64.add", thenArm);
      // else arm: a - b
      const elseArm = E.newSink();
      E.emitLocalGet(0, elseArm);
      E.emitLocalGet(1, elseArm);
      E.emitBinary("f64.sub", elseArm);
      const emptyBlock: BlockType = { kind: "empty" };
      E.emitIf(emptyBlock, thenArm, elseArm, s);
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

  // ── #1584 production opcodes: DIV / CMP_NE / TEE / GLOBAL_GET/SET / SELECT /
  // DROP, exercised through BOTH the host VM (runSink) and the compiled VM. ──
  // These are the additive op-set #958 committed to the emitter; this confirms
  // bytecode-vm.ts realizes each, with host-VM == Wasm-GC-VM equivalence.
  it("WasmGC-VM == host-VM for DIV / CMP_NE / SELECT / TEE / DROP / GLOBAL_*", async () => {
    // DIV: f(a,b) = a / b
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary("f64.div", s);
      E.emitReturn(s);
      const mod = compileVmModule(["a", "b"], s.code, s.constPool, ["a", "b"]);
      for (const [a, b] of [
        [6, 3],
        [7, 2],
        [-9, 3],
        [1, 4],
      ]) {
        expect(runSink(s, [a, b]), `host div(${a},${b})`).toBe(a / b);
        expect(await runWasm(mod, "run", [a, b]), `wasm div(${a},${b})`).toBe(a / b);
      }
    }
    // CMP_NE: f(a,b) = (a != b) ? 1 : 0
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary("f64.ne", s);
      E.emitReturn(s);
      const mod = compileVmModule(["a", "b"], s.code, s.constPool, ["a", "b"]);
      for (const [a, b] of [
        [1, 1],
        [1, 2],
        [-3, -3],
      ]) {
        const exp = a !== b ? 1 : 0;
        expect(runSink(s, [a, b]), `host ne(${a},${b})`).toBe(exp);
        expect(await runWasm(mod, "run", [a, b]), `wasm ne(${a},${b})`).toBe(exp);
      }
    }
    // SELECT: f(a,b,c) = (c != 0) ? a : b. Operand order per OP.SELECT: a, b, cond.
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s); // a
      E.emitLocalGet(1, s); // b
      E.emitLocalGet(2, s); // cond
      s.emit(OP.SELECT);
      E.emitReturn(s);
      const mod = compileVmModule(["a", "b", "c"], s.code, s.constPool, ["a", "b", "c"]);
      for (const [a, b, c] of [
        [10, 20, 1],
        [10, 20, 0],
        [-5, 5, 7],
      ]) {
        const exp = c !== 0 ? a : b;
        expect(runSink(s, [a, b, c]), `host select(${a},${b},${c})`).toBe(exp);
        expect(await runWasm(mod, "run", [a, b, c]), `wasm select(${a},${b},${c})`).toBe(exp);
      }
    }
    // TEE: f(a) = { local1 = (a+1) [tee leaves it on stack]; return top * 2 }.
    // sequence: LOAD a, CONST 1, ADD, TEE 1, CONST 2, MUL, RET → (a+1)*2.
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      emitNumberConst(1, s);
      E.emitBinary("f64.add", s);
      E.emitLocalTee(1, s); // peek -> local1, leaves (a+1) on stack
      emitNumberConst(2, s);
      E.emitBinary("f64.mul", s);
      E.emitReturn(s);
      const mod = compileVmModule(["a"], s.code, s.constPool, ["a", "0"]);
      for (const a of [3, -4, 0, 1.5]) {
        const exp = (a + 1) * 2;
        expect(runSink(s, [a, 0]), `host tee(${a})`).toBe(exp);
        expect(await runWasm(mod, "run", [a]), `wasm tee(${a})`).toBe(exp);
      }
    }
    // DROP: f(a) = { push a; push 99; DROP; return top } → a (99 discarded).
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      emitNumberConst(99, s);
      E.emitDrop(s);
      E.emitReturn(s);
      const mod = compileVmModule(["a"], s.code, s.constPool, ["a"]);
      for (const a of [3, -4, 0, 1.5]) {
        expect(runSink(s, [a]), `host drop(${a})`).toBe(a);
        expect(await runWasm(mod, "run", [a]), `wasm drop(${a})`).toBe(a);
      }
    }
    // GLOBAL_SET / GLOBAL_GET: f(a) = { global0 = a*3; return global0 }.
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      emitNumberConst(3, s);
      E.emitBinary("f64.mul", s);
      E.emitGlobalSet(0, s);
      E.emitGlobalGet(0, s);
      E.emitReturn(s);
      const mod = compileVmModule(["a"], s.code, s.constPool, ["a"]);
      for (const a of [3, -4, 0, 1.5]) {
        expect(runSink(s, [a]), `host global(${a})`).toBe(a * 3);
        expect(await runWasm(mod, "run", [a]), `wasm global(${a})`).toBe(a * 3);
      }
    }
  });

  // ── #1584 a1 call family: CALL (direct) + CALL_REF (indirect via funcref) ──
  // The VM becomes a multi-frame call-stack machine over a function table.
  // PROGRAM A drives a direct CALL between two functions through BOTH the host
  // VM (runProgram) and the compiled VM (compileProgramModule), asserting
  // host-VM == Wasm-GC-VM == JS. PROGRAM B drives CALL_REF over a synthesized
  // funcref-on-stack; the null-funcref (f64(-1)) case must trap.
  it("a1: CALL — host-VM == WasmGC-VM == JS for main(a,b)=add(a,b)", async () => {
    // functions[1] = add(a,b) = a + b   →  LOAD 0; LOAD 1; ADD; RET
    const add = new BytecodeSink();
    E.emitLocalGet(0, add);
    E.emitLocalGet(1, add);
    E.emitBinary("f64.add", add);
    E.emitReturn(add);
    // functions[0] = main(a,b) = add(a,b)  →  LOAD 0; LOAD 1; CALL 1; RET
    const main = new BytecodeSink();
    E.emitLocalGet(0, main);
    E.emitLocalGet(1, main);
    main.emit(OP.CALL, 1); // CALL funcIdx 1 (add)
    E.emitReturn(main);

    const functions: FuncEntry[] = [
      {
        code: main.code.slice(),
        constPool: main.constPool.slice(),
        arity: 2,
        nLocals: 2,
      },
      {
        code: add.code.slice(),
        constPool: add.constPool.slice(),
        arity: 2,
        nLocals: 2,
      },
    ];
    const program: Program = { functions, entry: 0 };
    const js = (a: number, b: number): number => a + b;

    const vmMod = compileProgramModule(
      ["a", "b"],
      functions.map((f) => ({
        code: f.code,
        constPool: f.constPool,
        arity: f.arity,
        nLocals: f.nLocals,
      })),
      0,
      ["a", "b"],
    );

    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      const expected = js(a, b);
      expect(runProgram(program, [a, b]), `host CALL add(${a},${b})`).toBe(expected);
      expect(await runWasm(vmMod, "run", [a, b]), `wasm CALL add(${a},${b})`).toBe(expected);
    }
  });

  it("a1: CALL_REF — host-VM dispatches funcref≡f64(tableIdx); null≡f64(-1) traps", async () => {
    // functions[1] = add(a,b) = a + b. functions[0] = entry that pushes
    // a, b, then the funcref f64(1) on top, then CALL_REF.
    const add = new BytecodeSink();
    E.emitLocalGet(0, add);
    E.emitLocalGet(1, add);
    E.emitBinary("f64.add", add);
    E.emitReturn(add);

    // entry: LOAD 0; LOAD 1; CONST f64(1) [funcref=tableIdx 1]; CALL_REF <typeIdx>; RET
    const entry = new BytecodeSink();
    E.emitLocalGet(0, entry);
    E.emitLocalGet(1, entry);
    emitNumberConst(1, entry); // funcref ≡ f64(1)
    entry.emit(OP.CALL_REF, 0); // typeIdx operand is informational
    E.emitReturn(entry);

    const functions: FuncEntry[] = [
      {
        code: entry.code.slice(),
        constPool: entry.constPool.slice(),
        arity: 2,
        nLocals: 2,
      },
      {
        code: add.code.slice(),
        constPool: add.constPool.slice(),
        arity: 2,
        nLocals: 2,
      },
    ];
    const program: Program = { functions, entry: 0 };

    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [7, 7],
    ]) {
      expect(runProgram(program, [a, b]), `host CALL_REF add(${a},${b})`).toBe(a + b);
    }

    // null-funcref: push f64(-1) then CALL_REF → must trap.
    const nullEntry = new BytecodeSink();
    E.emitLocalGet(0, nullEntry);
    E.emitLocalGet(1, nullEntry);
    emitNumberConst(-1, nullEntry); // null funcref sentinel
    nullEntry.emit(OP.CALL_REF, 0);
    E.emitReturn(nullEntry);
    const nullProgram: Program = {
      functions: [
        {
          code: nullEntry.code.slice(),
          constPool: nullEntry.constPool.slice(),
          arity: 2,
          nLocals: 2,
        },
        {
          code: add.code.slice(),
          constPool: add.constPool.slice(),
          arity: 2,
          nLocals: 2,
        },
      ],
      entry: 0,
    };
    expect(() => runProgram(nullProgram, [1, 2]), "null funcref CALL_REF traps").toThrow(/null funcref/);
  });

  // ── Sanity: the host VM still rejects malformed; the emitter rejects ops ──
  // outside the #1584 production subset. (The subset has grown with #958:
  // f64.div / f64.ne are now IN-subset, so the out-of-subset probe uses ops the
  // production emitter still rejects — a binary not in binopToOpcode and a unary
  // that isn't f64.neg.)
  it("host VM rejects malformed + out-of-subset ops", () => {
    const s = new BytecodeSink();
    emitNumberConst(1, s); // never RET → runs off the end
    expect(() => runSink(s, [])).toThrow(/unknown opcode/);
    // f64.min has no opcode in the production subset → emitter throws.
    expect(() => E.emitBinary("f64.min", s)).toThrow(/not in the #1584/);
    // Only f64.neg is a supported unary; i32.eqz is rejected.
    expect(() => E.emitUnary("i32.eqz", s)).toThrow(/not in the #1584/);
  });
});
