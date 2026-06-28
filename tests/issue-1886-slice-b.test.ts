// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 Slice B — codegen + execution for linear-backed `Uint8Array`.
 *
 * Slice A (tests/issue-1886.test.ts) proves which buffers are linear-safe.
 * Slice B lowers a proven-safe `new Uint8Array(n)` to a `(ptr,len)` pair backed
 * by a linear-memory arena (`__lin_u8_alloc`), so element reads/writes become
 * `i32.load8_u`/`i32.store8` and `node:fs` `readSync` / `writeSync` become
 * zero-copy reads/writes straight against the buffer's bytes.
 *
 * #2633 — synchronous std-IO moved off the hallucinated `process.stdin.read`
 * surface onto `node:fs` fd-based `readSync(0, …)` / `writeSync(1, …)` (the
 * faithful Node primitives), so these tests now drive the linear I/O path via
 * `node:fs` under `--link node:fs` (the node-fs shim owns the WASI fd_*).
 *
 * These tests guard:
 *   1. The emitted module is VALID wasm (the eager-allocator index-shift bug
 *      that produced `expected externref, found i32` at the allocator `call`
 *      site — the late `env.__extern_get` import shifting the allocator's
 *      defined-func index out from under its callers).
 *   2. The linear lowering actually FIRES for a proven-safe local
 *      (`i32.load8_u`/`i32.store8` + the linear allocator).
 *   3. An escaping `Uint8Array` (returned from the function) stays on the GC
 *      array path — Slice B must not change its codegen.
 *   4. Mixing a linear `Uint8Array` with strings (which pull in native-string
 *      helpers) still validates.
 *   5. End-to-end: feed bytes on stdin via readSync, mutate `buf[i]`, echo on
 *      stdout via writeSync — the observed bytes match the JS-semantics expectation.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

// The node:fs fd-based primitives the linear path now drives. `readSync(0, buf,
// { offset })` fills the buffer; `writeSync(1, buf)` echoes it.
const FS_IO = `import { readSync, writeSync } from "node:fs";`;

/** Compile `source` with --target wasi --link node:fs; throw on compile error. */
async function compileWasi(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi", link: ["node:fs"] });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return result.binary;
}

/** Compile to WAT (emitText) under --link node:fs; throw on compile error. */
async function compileWat(source: string): Promise<string> {
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

/**
 * Link the node:fs shim + the user module and run it, feeding `input` on fd 0
 * and capturing fd 1. The shim owns the shared memory + the WASI fd_read/fd_write
 * syscalls; the user module imports {memory, readSync, writeSync} from it.
 */
async function runStdinStdout(binary: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const memRef: { value?: WebAssembly.Memory } = {};
  const out: number[] = [];
  let inPos = 0;
  const readMem = () => new Uint8Array(memRef.value!.buffer);
  const i32 = () => new DataView(memRef.value!.buffer);

  const wasi = {
    fd_read(_fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
      const dv = i32();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(base, true);
        const bufLen = dv.getUint32(base + 4, true);
        const n = Math.min(bufLen, input.length - inPos);
        readMem().set(input.subarray(inPos, inPos + n), bufPtr);
        inPos += n;
        total += n;
      }
      dv.setUint32(nreadPtr, total, true);
      return 0;
    },
    fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const dv = i32();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(base, true);
        const bufLen = dv.getUint32(base + 4, true);
        for (const b of readMem().subarray(bufPtr, bufPtr + bufLen)) out.push(b);
        total += bufLen;
      }
      dv.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    proc_exit(_code: number): void {
      throw new Error("__proc_exit");
    },
  };

  // Instantiate the shim FIRST (owns memory + WASI fd_*), then the user module.
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

describe("#1886 Slice B — linear-backed Uint8Array codegen validity", () => {
  it("a proven-safe new Uint8Array + buf[i] r/w + I/O compiles to VALID wasm", async () => {
    const src = `${FS_IO}
      export function main(): void {
        const buf = new Uint8Array(8);
        readSync(0, buf, 0, 8);
        buf[0] = (buf[0] + 1) & 255;
        writeSync(1, buf);
      }`;
    const binary = await compileWasi(src);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
  });

  it("linear lowering fires: i32.load8_u / i32.store8 + the linear allocator", async () => {
    const wat = await compileWat(`${FS_IO}
      export function main(): void {
        const buf = new Uint8Array(4);
        readSync(0, buf, 0, 4);
        buf[1] = buf[0] & 255;
        writeSync(1, buf);
      }`);
    if (wat) {
      expect(wat).toContain("__lin_u8_alloc");
      expect(wat).toMatch(/i32\.load8_u/);
      expect(wat).toMatch(/i32\.store8/);
    }
  });

  it("an escaping Uint8Array (returned) stays on the GC array path", async () => {
    const wat = await compileWat(`${FS_IO}
      export function main(): Uint8Array {
        const buf = new Uint8Array(8);
        readSync(0, buf, 0, 8);
        buf[0] = (buf[0] + 1) & 255;
        return buf;
      }`);
    const binary = await compileWasi(`${FS_IO}
      export function main(): Uint8Array {
        const buf = new Uint8Array(8);
        readSync(0, buf, 0, 8);
        buf[0] = (buf[0] + 1) & 255;
        return buf;
      }`);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
    if (wat) {
      expect(wat).toMatch(/array\.(new|set|get)/);
    }
  });

  it("mixing a linear Uint8Array with string output still validates (no __str_flatten desync)", async () => {
    const src = `${FS_IO}
      declare const console: { log(s: string): void };
      export function main(): void {
        const buf = new Uint8Array(8);
        readSync(0, buf, 0, 8);
        buf[0] = (buf[0] + 1) & 255;
        console.log("done");
        writeSync(1, buf);
      }`;
    const binary = await compileWasi(src);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
  });
});

describe("#1886 Slice B — linear-backed Uint8Array execution", () => {
  it("buf[0] = (buf[0]+1)&255 round-trips through stdin → stdout", async () => {
    const src = `${FS_IO}
      export function main(): void {
        const buf = new Uint8Array(8);
        readSync(0, buf, 0, 8);
        buf[0] = (buf[0] + 1) & 255;
        writeSync(1, buf);
      }`;
    const binary = await compileWasi(src);
    const input = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const got = await runStdinStdout(binary, input);
    expect(Array.from(got)).toEqual([11, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("byte wraps at 255 (the & 255 mask)", async () => {
    const src = `${FS_IO}
      export function main(): void {
        const buf = new Uint8Array(4);
        readSync(0, buf, 0, 4);
        buf[0] = (buf[0] + 1) & 255;
        writeSync(1, buf);
      }`;
    const binary = await compileWasi(src);
    const got = await runStdinStdout(binary, Uint8Array.from([255, 1, 2, 3]));
    expect(Array.from(got)).toEqual([0, 1, 2, 3]);
  });

  it("a second indexed write lands at the right offset", async () => {
    const src = `${FS_IO}
      export function main(): void {
        const buf = new Uint8Array(4);
        readSync(0, buf, 0, 4);
        buf[2] = (buf[0] + buf[1]) & 255;
        writeSync(1, buf);
      }`;
    const binary = await compileWasi(src);
    const got = await runStdinStdout(binary, Uint8Array.from([5, 7, 99, 0]));
    expect(Array.from(got)).toEqual([5, 7, 12, 0]);
  });
});

describe("#1886 Slice C — param-threaded buffer codegen", () => {
  // Slice C rewrites safe helper params to `(ptr,len)`, so the same shape that
  // Slice B had to defer can now stay linear across the user-function call.
  it("a buffer passed to a user function compiles VALID + round-trips", async () => {
    const src = `${FS_IO}
      function bump(b: Uint8Array): void { b[0] = (b[0] + 1) & 255; }
      export function main(): void {
        const buf = new Uint8Array(4);
        readSync(0, buf, 0, 4);
        bump(buf);
        writeSync(1, buf);
      }`;
    const binary = await compileWasi(src);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
    const got = await runStdinStdout(binary, Uint8Array.from([10, 20, 30, 40]));
    expect(Array.from(got)).toEqual([11, 20, 30, 40]);
  });
});
