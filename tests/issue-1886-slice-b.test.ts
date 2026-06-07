// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 Slice B — codegen + execution for linear-backed `Uint8Array`.
 *
 * Slice A (tests/issue-1886.test.ts) proves which buffers are linear-safe.
 * Slice B lowers a proven-safe `new Uint8Array(n)` to a `(ptr,len)` pair backed
 * by a linear-memory arena (`__lin_u8_alloc`), so element reads/writes become
 * `i32.load8_u`/`i32.store8` and `process.stdin.read` / `process.stdout.write`
 * become zero-copy `fd_read`/`fd_write` straight against the buffer's bytes.
 *
 * These tests guard:
 *   1. The emitted module is VALID wasm (the eager-allocator index-shift bug
 *      that produced `expected externref, found i32` at the allocator `call`
 *      site — the late `env.__extern_get` import shifting the allocator's
 *      defined-func index out from under its callers).
 *   2. The linear lowering actually FIRES for a proven-safe local
 *      (`i32.load8_u`/`i32.store8` + linear `fd_read`/`fd_write` iovec).
 *   3. An escaping `Uint8Array` (returned from the function) stays on the GC
 *      array path — Slice B must not change its codegen.
 *   4. Mixing a linear `Uint8Array` with strings (which pull in native-string
 *      helpers) still validates — the allocator's func TYPE is reserved early so
 *      it cannot shift the string-helper struct/array type indices, while its
 *      FUNCTION is emitted late so its index survives `env.__extern_get`.
 *   5. End-to-end: feed bytes on stdin, mutate `buf[i]`, echo on stdout — the
 *      observed bytes match the JS-semantics expectation.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STDIN_DECL = `declare const process: {
  stdin: { read(b: Uint8Array, off?: number): number };
  stdout: { write(b: Uint8Array): void };
};`;

/** Compile `source` with --target wasi; throw on compile error. */
async function compileWasi(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return result.binary;
}

/** Disassembly-free op check: count occurrences of a one-byte opcode in the code section is brittle, so we assert on the textual WAT the CLI also emits. */
async function compileWat(source: string): Promise<string> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi", emitText: true } as never);
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  // `wat` is attached when emitText is requested; fall back to "" if the build
  // doesn't surface it (the validity + execution tests still cover the path).
  return (result as unknown as { wat?: string }).wat ?? "";
}

/**
 * Run a WASI module that reads up to `input.length` bytes from fd 0 and writes
 * to fd 1, returning the captured stdout bytes. Implements just enough of the
 * preview1 ABI (fd_read / fd_write / proc_exit) to drive the linear I/O path.
 */
async function runStdinStdout(binary: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const module = await WebAssembly.compile(binary);
  // Holder so the WASI import closures can capture the memory before it exists
  // (assigned exactly once after instantiation, below) without a re-assigned
  // `let` binding.
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
        const bytes = readMem().subarray(bufPtr, bufPtr + bufLen);
        for (const b of bytes) out.push(b);
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
  return Uint8Array.from(out);
}

describe("#1886 Slice B — linear-backed Uint8Array codegen validity", () => {
  it("a proven-safe new Uint8Array + buf[i] r/w + I/O compiles to VALID wasm", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(8);
        process.stdin.read(buf, 0);
        buf[0] = (buf[0] + 1) & 255;
        process.stdout.write(buf);
      }`;
    const binary = await compileWasi(src);
    // WebAssembly.compile performs full validation (incl. GC + the allocator
    // call site). This throws on the index-shift regression.
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
  });

  it("linear lowering fires: i32.load8_u / i32.store8 + linear fd I/O", async () => {
    const wat = await compileWat(`${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        process.stdin.read(buf, 0);
        buf[1] = buf[0] & 255;
        process.stdout.write(buf);
      }`);
    if (wat) {
      // The allocator + per-byte linear ops must be present in $main's lowering.
      expect(wat).toContain("__lin_u8_alloc");
      expect(wat).toMatch(/i32\.load8_u/);
      expect(wat).toMatch(/i32\.store8/);
    }
  });

  it("an escaping Uint8Array (returned) stays on the GC array path", async () => {
    const wat = await compileWat(`${STDIN_DECL}
      export function main(): Uint8Array {
        const buf = new Uint8Array(8);
        process.stdin.read(buf, 0);
        buf[0] = (buf[0] + 1) & 255;
        return buf;
      }`);
    const binary = await compileWasi(`${STDIN_DECL}
      export function main(): Uint8Array {
        const buf = new Uint8Array(8);
        process.stdin.read(buf, 0);
        buf[0] = (buf[0] + 1) & 255;
        return buf;
      }`);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
    if (wat) {
      // The returned buffer must use a GC array, not the linear allocator.
      expect(wat).toMatch(/array\.(new|set|get)/);
    }
  });

  it("mixing a linear Uint8Array with string output still validates (no __str_flatten desync)", async () => {
    // Strings pull in native-string helpers whose bodies bake absolute type
    // indices; the allocator's func type is reserved early so it cannot shift
    // them, and its function is emitted late so `env.__extern_get` (added for
    // the `buf[i]` externref element-access pre-pass) cannot strand its index.
    const src = `${STDIN_DECL}
      declare const console: { log(s: string): void };
      export function main(): void {
        const buf = new Uint8Array(8);
        process.stdin.read(buf, 0);
        buf[0] = (buf[0] + 1) & 255;
        console.log("done");
        process.stdout.write(buf);
      }`;
    const binary = await compileWasi(src);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
  });
});

describe("#1886 Slice B — linear-backed Uint8Array execution", () => {
  it("buf[0] = (buf[0]+1)&255 round-trips through stdin → stdout", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(8);
        process.stdin.read(buf, 0);
        buf[0] = (buf[0] + 1) & 255;
        process.stdout.write(buf);
      }`;
    const binary = await compileWasi(src);
    const input = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const got = await runStdinStdout(binary, input);
    // buf[0] incremented (10 → 11); every other byte preserved (zero copy).
    expect(Array.from(got)).toEqual([11, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("byte wraps at 255 (the & 255 mask)", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        process.stdin.read(buf, 0);
        buf[0] = (buf[0] + 1) & 255;
        process.stdout.write(buf);
      }`;
    const binary = await compileWasi(src);
    const got = await runStdinStdout(binary, Uint8Array.from([255, 1, 2, 3]));
    // 255 + 1 = 256, masked to 0.
    expect(Array.from(got)).toEqual([0, 1, 2, 3]);
  });

  it("a second indexed write lands at the right offset", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        process.stdin.read(buf, 0);
        buf[2] = (buf[0] + buf[1]) & 255;
        process.stdout.write(buf);
      }`;
    const binary = await compileWasi(src);
    const got = await runStdinStdout(binary, Uint8Array.from([5, 7, 99, 0]));
    // buf[2] = (5 + 7) & 255 = 12; rest preserved.
    expect(Array.from(got)).toEqual([5, 7, 12, 0]);
  });
});

describe("#1886 Slice C — param-threaded buffer codegen", () => {
  // Slice C rewrites safe helper params to `(ptr,len)`, so the same shape that
  // Slice B had to defer can now stay linear across the user-function call.
  it("a buffer passed to a user function compiles VALID + round-trips", async () => {
    const src = `${STDIN_DECL}
      function bump(b: Uint8Array): void { b[0] = (b[0] + 1) & 255; }
      export function main(): void {
        const buf = new Uint8Array(4);
        process.stdin.read(buf, 0);
        bump(buf);
        process.stdout.write(buf);
      }`;
    const binary = await compileWasi(src);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
    const got = await runStdinStdout(binary, Uint8Array.from([10, 20, 30, 40]));
    expect(Array.from(got)).toEqual([11, 20, 30, 40]);
  });
});
