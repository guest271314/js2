// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 — Linear-safe `Uint8Array` escape/usage analysis (Slice A).
 *
 * These tests exercise the analysis in isolation (no codegen): given a TS
 * source, which `Uint8Array` bindings does it prove linear-safe, and which
 * does it correctly reject? The analysis must mark every buffer in the
 * native-messaging host linear-safe (including the ones threaded through
 * helper-function parameters) and must reject buffers that escape to a
 * GC-requiring context.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeLinearUint8 } from "../src/codegen/linear-uint8-analysis.js";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const STDIN_DECL = `declare const process: {
  stdin: { read(b: Uint8Array, off?: number): number };
  stdout: { write(b: Uint8Array): void };
};`;

/** Compile `src` to a Program in-memory and run the analysis on it. */
function analyze(src: string): {
  safeNames: Set<string>;
  linearParamFns: Map<string, number[]>;
  localOnlyNames: Set<string>;
} {
  const fileName = "test.ts";
  const sourceFileObj = ts.createSourceFile(fileName, src, ts.ScriptTarget.ES2022, true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) =>
      name === fileName ? sourceFileObj : ts.createSourceFile(name, "", ts.ScriptTarget.ES2022, true),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (n) => n === fileName || n === "lib.d.ts",
    readFile: (n) => (n === fileName ? src : ""),
  };
  const program = ts.createProgram([fileName], { noLib: true, target: ts.ScriptTarget.ES2022 }, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(fileName)!;
  const result = analyzeLinearUint8(checker, sf);

  const safeNames = new Set<string>();
  for (const sym of result.safeBindings) safeNames.add(sym.name);
  const linearParamFns = new Map<string, number[]>();
  for (const [fnSym, idxs] of result.linearParams) linearParamFns.set(fnSym.name, [...idxs].sort());
  const localOnlyNames = new Set<string>();
  for (const sym of result.localOnlyBindings) localOnlyNames.add(sym.name);
  return { safeNames, linearParamFns, localOnlyNames };
}

async function compileWasi(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return result.binary;
}

async function compileWat(source: string): Promise<string> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi", emitText: true } as never);
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return (result as unknown as { wat?: string }).wat ?? "";
}

// #2633 — node:fs readSync/writeSync are supported under --link node:fs; the
// node-fs shim owns the shared memory + WASI fd_*. These helpers compile + run a
// user module that drives the linear I/O path through that shim.
async function compileWasiShim(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi", link: ["node:fs"] });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return result.binary;
}

async function compileWat2(source: string): Promise<string> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "wasi",
    link: ["node:fs"],
    emitText: true,
  } as never);
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return (result as unknown as { wat?: string }).wat ?? "";
}

async function runStdinStdoutShim(binary: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const memRef: { value?: WebAssembly.Memory } = {};
  const out: number[] = [];
  let inPos = 0;
  const mem = () => new Uint8Array(memRef.value!.buffer);
  const view = () => new DataView(memRef.value!.buffer);
  const wasi = {
    fd_read(_fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
      const dv = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(base, true);
        const bufLen = dv.getUint32(base + 4, true);
        const n = Math.min(bufLen, input.length - inPos);
        mem().set(input.subarray(inPos, inPos + n), bufPtr);
        inPos += n;
        total += n;
      }
      dv.setUint32(nreadPtr, total, true);
      return 0;
    },
    fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const dv = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(base, true);
        const bufLen = dv.getUint32(base + 4, true);
        for (const b of mem().subarray(bufPtr, bufPtr + bufLen)) out.push(b);
        total += bufLen;
      }
      dv.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    proc_exit(_code: number): void {
      throw new Error("__proc_exit");
    },
  };
  const shim = new WebAssembly.Instance(new WebAssembly.Module(buildNodeFsShim()), {
    wasi_snapshot_preview1: wasi,
  });
  memRef.value = shim.exports.memory as WebAssembly.Memory;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    "node:fs": {
      memory: shim.exports.memory,
      readSync: shim.exports.readSync,
      writeSync: shim.exports.writeSync,
    },
    env: {},
  });
  const entry = (instance.exports.main ?? instance.exports._start) as undefined | (() => void);
  if (!entry) throw new Error("no main/_start export");
  try {
    entry();
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__proc_exit") throw e;
  }
  return Uint8Array.from(out);
}

async function runStdinStdoutWithMemory(
  binary: Uint8Array,
  input: Uint8Array,
): Promise<{ stdout: Uint8Array; memoryBytes: number }> {
  const module = await WebAssembly.compile(binary);
  const memRef: { value?: WebAssembly.Memory } = {};
  const out: number[] = [];
  let inPos = 0;

  const mem = () => new Uint8Array(memRef.value!.buffer);
  const view = () => new DataView(memRef.value!.buffer);

  const wasi = {
    fd_read(_fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
      const dv = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(base, true);
        const bufLen = dv.getUint32(base + 4, true);
        const n = Math.min(bufLen, input.length - inPos);
        mem().set(input.subarray(inPos, inPos + n), bufPtr);
        inPos += n;
        total += n;
      }
      dv.setUint32(nreadPtr, total, true);
      return 0;
    },
    fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const dv = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(base, true);
        const bufLen = dv.getUint32(base + 4, true);
        for (const b of mem().subarray(bufPtr, bufPtr + bufLen)) out.push(b);
        total += bufLen;
      }
      dv.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    proc_exit(_code: number): void {
      throw new Error("__proc_exit");
    },
  };

  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  memRef.value = exports.memory as WebAssembly.Memory;
  const entry = (exports.main ?? exports._start) as undefined | (() => void);
  if (!entry) throw new Error("no main/_start export");
  try {
    entry();
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__proc_exit") throw e;
  }
  return { stdout: Uint8Array.from(out), memoryBytes: memRef.value!.buffer.byteLength };
}

async function runStdinStdout(binary: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  return (await runStdinStdoutWithMemory(binary, input)).stdout;
}

describe("#1886 linear-safe Uint8Array analysis", () => {
  it("marks a plain indexed I/O buffer linear-safe", () => {
    // #2633 — synchronous stdin is node:fs readSync (process.stdin.read removed);
    // both readSync(0, buf, …) and process.stdout.write(buf) are byte-I/O sinks.
    const { safeNames, localOnlyNames } = analyze(`
      import { readSync } from "node:fs";
      declare const process: { stdout: { write(b: Uint8Array): void } };
      export function main(): void {
        const buf = new Uint8Array(16);
        readSync(0, buf, 0, 16);
        let x = buf[0];
        buf[1] = 42;
        const n = buf.length;
        process.stdout.write(buf);
      }
    `);
    expect(safeNames.has("buf")).toBe(true);
    // Slice B: a `new Uint8Array` local whose only call-arg uses are the I/O
    // intrinsics is intraprocedurally linear-backable.
    expect(localOnlyNames.has("buf")).toBe(true);
  });

  it("rejects a buffer stored into an object (escapes to GC)", () => {
    const { safeNames } = analyze(`
      export function main(): void {
        const buf = new Uint8Array(16);
        const holder: { b: Uint8Array } = { b: buf };
        buf[0] = 1;
      }
    `);
    expect(safeNames.has("buf")).toBe(false);
  });

  it("rejects a buffer returned from a function", () => {
    const { safeNames } = analyze(`
      function make(): Uint8Array {
        const buf = new Uint8Array(16);
        buf[0] = 1;
        return buf;
      }
      export function main(): void { make(); }
    `);
    expect(safeNames.has("buf")).toBe(false);
  });

  it("rejects a buffer aliased then escaped", () => {
    const { safeNames } = analyze(`
      declare const sink: { keep(x: Uint8Array): void };
      export function main(): void {
        const buf = new Uint8Array(16);
        buf[0] = 1;
        const alias = buf;
        sink.keep(alias);
      }
    `);
    // 'buf' is referenced by `const alias = buf` — a copy-into-binding escape.
    expect(safeNames.has("buf")).toBe(false);
  });

  it("rejects a buffer used via .subarray / .slice", () => {
    const { safeNames } = analyze(`
      export function main(): void {
        const buf = new Uint8Array(16);
        buf[0] = 1;
        const part = buf.subarray(0, 4);
      }
    `);
    expect(safeNames.has("buf")).toBe(false);
  });

  it("threads linear-safety through a helper parameter (interprocedural)", () => {
    const { safeNames, linearParamFns, localOnlyNames } = analyze(`
      import { readSync } from "node:fs";
      function readExact(buf: Uint8Array, n: number): boolean {
        let got = 0;
        while (got < n) {
          const r = readSync(0, buf, got);
          if (r <= 0) return false;
          got = got + r;
        }
        return true;
      }
      export function main(): void {
        const header = new Uint8Array(4);
        readExact(header, 4);
      }
    `);
    expect(safeNames.has("header")).toBe(true);
    expect(safeNames.has("buf")).toBe(true); // the helper param
    expect(linearParamFns.get("readExact")).toEqual([0]);
    // Slice B excludes param-threaded buffers: `header` flows into a user
    // function, so it stays GC until the Slice-C signature rewrite. `buf` is a
    // parameter and is never local-only.
    expect(localOnlyNames.has("header")).toBe(false);
    expect(localOnlyNames.has("buf")).toBe(false);
  });

  it("demotes the caller buffer when the helper param escapes", () => {
    const { safeNames } = analyze(`
      declare const sink: { keep(x: Uint8Array): void };
      function leak(buf: Uint8Array): void { sink.keep(buf); }
      export function main(): void {
        const header = new Uint8Array(4);
        leak(header);
      }
    `);
    // 'buf' escapes (passed to host import) → demoted; the arg into it
    // (`header`) is then a pass-to-non-linear-param → also demoted.
    expect(safeNames.has("buf")).toBe(false);
    expect(safeNames.has("header")).toBe(false);
  });

  it("does not make an exported function's Uint8Array param linear (observable ABI)", () => {
    const { safeNames, linearParamFns } = analyze(`
      declare const process: { stdout: { write(b: Uint8Array): void } };
      export function writeIt(buf: Uint8Array): void {
        process.stdout.write(buf);
      }
    `);
    expect(safeNames.has("buf")).toBe(false);
    expect(linearParamFns.has("writeIt")).toBe(false);
  });

  it("classifies every buffer in the native-messaging host as linear-safe", () => {
    // #2631 — the example now uses node:fs fd-based readSync/writeSync (the
    // faithful synchronous Node primitives) instead of process.std*.{read,write}.
    // The #1886 analysis recognises readSync(fd, buf, …)/writeSync(fd, buf, …) as
    // byte-I/O buffer sinks (ioBufferArgIndex), so every buffer stays linear-safe.
    const nmPath = resolve(here, "../examples/native-messaging/nm_js2wasm_node_fs.ts");
    const src = readFileSync(nmPath, "utf-8");
    const { safeNames, linearParamFns } = analyze(src);
    // Buffers declared in main + the per-frame temporaries + the write buffer
    // (`out`) and the stderr-telemetry byte buffer (`bytes`).
    for (const name of ["header", "one", "buf", "tmp", "out", "src", "bytes"]) {
      expect(safeNames.has(name), `expected '${name}' linear-safe`).toBe(true);
    }
    // Helper params that carry buffers must be linear-rewritten.
    expect(linearParamFns.get("readExact")).toContain(0);
    expect(linearParamFns.get("readAt")).toContain(0);
    expect(linearParamFns.get("writeAll")).toContain(0);
    expect(linearParamFns.get("decodeLength")).toContain(0);
    expect(linearParamFns.get("emitRun")).toContain(0);
  });
});

describe("#1886 Slice C interprocedural linear Uint8Array params", () => {
  it("passes a linear-backed buffer into a helper as ptr/len and mutates it in place", async () => {
    // #2633 — node:fs readSync/writeSync (process.stdin.read removed).
    const src = `import { readSync, writeSync } from "node:fs";
      function bump(b: Uint8Array): void {
        b[0] = (b[0] + 1) & 255;
      }
      export function main(): void {
        const buf = new Uint8Array(4);
        readSync(0, buf, 0, 4);
        bump(buf);
        writeSync(1, buf);
      }`;
    const wat = await compileWat2(src);
    if (wat) {
      expect(wat).toContain("__lin_u8_alloc");
      expect(wat).toMatch(/i32\.load8_u/);
      expect(wat).toMatch(/i32\.store8/);
    }
    const got = await runStdinStdoutShim(await compileWasiShim(src), Uint8Array.from([10, 20, 30, 40]));
    expect(Array.from(got)).toEqual([11, 20, 30, 40]);
  });

  it("uses the ptr/len helper param for zero-copy stdin reads with an offset", async () => {
    const src = `import { readSync, writeSync } from "node:fs";
      function readAt(b: Uint8Array, off: number): void {
        readSync(0, b, off);
      }
      export function main(): void {
        const buf = new Uint8Array(4);
        readAt(buf, 1);
        writeSync(1, buf);
      }`;
    const got = await runStdinStdoutShim(await compileWasiShim(src), Uint8Array.from([7, 8, 9, 10]));
    expect(Array.from(got)).toEqual([0, 7, 8, 9]);
  });

  it("keeps helpers that read arguments on the GC ABI", () => {
    const { safeNames, linearParamFns } = analyze(`${STDIN_DECL}
      function writeIt(buf: Uint8Array): void {
        const n = arguments.length;
        process.stdout.write(buf);
      }
      export function main(): void {
        const buf = new Uint8Array(4);
        writeIt(buf);
      }`);
    expect(safeNames.has("buf")).toBe(false);
    expect(linearParamFns.has("writeIt")).toBe(false);
  });

  it("rewinds loop-local linear allocations instead of growing per iteration", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        let i = 0;
        while (i < 12) {
          const buf = new Uint8Array(256 * 1024);
          buf[0] = 65 + i;
          process.stdout.write(buf);
          i = i + 1;
        }
      }`;
    const run = await runStdinStdoutWithMemory(await compileWasi(src), new Uint8Array());
    expect(run.memoryBytes).toBeLessThanOrEqual(10 * 64 * 1024);
    expect(run.stdout.length).toBe(12 * 256 * 1024);
    for (let i = 0; i < 12; i++) {
      expect(run.stdout[i * 256 * 1024]).toBe(65 + i);
      expect(run.stdout[i * 256 * 1024 + 1]).toBe(0);
    }
  });
});

describe("#1886 Slice B intraprocedural eligibility (localOnlyBindings)", () => {
  it("includes a local buffer built + written entirely in one function", () => {
    // `frame` is allocated, filled with an element loop, and written via the
    // I/O intrinsic — never threaded into a user function. Slice-B-eligible.
    const { safeNames, localOnlyNames } = analyze(`
      declare const process: { stdout: { write(b: Uint8Array): void } };
      function emit(runLen: number): void {
        const frame = new Uint8Array(runLen + 2);
        frame[0] = 91;
        let k = 0;
        while (k < runLen) { frame[k + 1] = 0; k = k + 1; }
        frame[runLen + 1] = 93;
        process.stdout.write(frame);
      }
      export function main(): void { emit(4); }
    `);
    expect(safeNames.has("frame")).toBe(true);
    expect(localOnlyNames.has("frame")).toBe(true);
  });

  it("excludes a local buffer passed to a user function (Slice-C territory)", () => {
    // `payload` is itself only indexed + I/O, BUT it is also handed to the
    // user helper `fill`. Without the Slice-C signature rewrite, backing it
    // linearly would pass a (ptr,len) to a GC-array param — so Slice B must
    // leave it on the GC path even though Slice A proves it safe.
    const { safeNames, localOnlyNames } = analyze(`
      declare const process: { stdout: { write(b: Uint8Array): void } };
      function fill(b: Uint8Array): void { b[0] = 1; }
      export function main(): void {
        const payload = new Uint8Array(8);
        fill(payload);
        process.stdout.write(payload);
      }
    `);
    expect(safeNames.has("payload")).toBe(true); // Slice A still proves it safe
    expect(localOnlyNames.has("payload")).toBe(false); // Slice B defers it
  });

  it("the native-messaging host: per-frame temporaries are Slice-B-eligible, the threaded read window is not", () => {
    // #2631 — with node:fs readSync/writeSync, `bytes` (the stderr-telemetry
    // buffer in `logFrameBodyRead`) is built + written entirely within one
    // function and only flows into writeSync (an I/O sink), so it is Slice-B
    // (local-only) eligible.
    const nmPath = resolve(here, "../examples/native-messaging/nm_js2wasm_node_fs.ts");
    const src = readFileSync(nmPath, "utf-8");
    const { localOnlyNames } = analyze(src);
    // `bytes` (logFrameBodyRead) is local-only — never threaded into a user fn.
    expect(localOnlyNames.has("bytes")).toBe(true);
    // `buf`/`header`/`one`/`tmp`/`out`/`src` flow through readExact/readAt/
    // writeAll/emitRun user params → param-threaded → deferred to Slice C, not
    // linear-backed now.
    for (const name of ["buf", "header", "one", "tmp", "out", "src"]) {
      expect(localOnlyNames.has(name), `expected '${name}' deferred (param-threaded)`).toBe(false);
    }
  });
});
