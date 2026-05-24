// #1618 — console.log of a *runtime* string under --target wasi must emit the
// string content, not the "[object]" placeholder that emitWasiValueToStdout
// previously wrote for every ref/ref_null value.
//
// #1651 — process.stdout.write(str) / process.stdout.write(new Uint8Array([...]))
// lower to fd_write(1, ...) with NO trailing newline (the Node.js API the
// Chrome Native Messaging host needs for its binary 4-byte length prefix).
//
// Both are validated by running the compiled module against a raw-byte WASI
// shim so non-UTF8 bytes and the absence of a newline are observed verbatim.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Run a compiled WASI module, returning the raw bytes written to a given fd. */
function runWasiCaptureFd(binary: Uint8Array, fd: number, stdin?: Uint8Array): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const memView = () => new DataView(ref.mem!.buffer);
  const captured: number[] = [];
  let pos = 0;
  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const view = memView();
      let total = 0;
      const src = stdin ?? new Uint8Array(0);
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, src.length - pos);
        new Uint8Array(ref.mem!.buffer, ptr, n).set(src.subarray(pos, pos + n));
        pos += n;
        total += n;
        if (n < len) break;
      }
      view.setUint32(nread, total, true);
      return 0;
    },
    fd_write(wfd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = memView();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        if (wfd === fd) for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) captured.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(): void {},
    random_get(): number {
      return 0;
    },
    clock_time_get(): number {
      return 0;
    },
  };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    wasi_snapshot_preview1: wasi,
    env: {},
  });
  ref.mem = inst.exports.memory as WebAssembly.Memory;
  (inst.exports.main as () => void)();
  return Uint8Array.from(captured);
}

describe("#1618 console.log of a runtime string under --target wasi", () => {
  it("emits the string content, not the [object] placeholder", () => {
    const src = `export function main(): void {
      const a = "hello";
      const b = a + " world";
      console.log(b);
    }`;
    const result = compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = new TextDecoder().decode(runWasiCaptureFd(result.binary, 1));
    expect(out).toContain("hello world");
    expect(out).not.toContain("[object]");
  });

  it("emits a template-literal runtime string (no extern-bridge host imports)", () => {
    const src = `export function main(): void {
      const name = "ts2wasm";
      console.log(\`built with \${name}\`);
    }`;
    const result = compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    // The JS-host string-marshal imports must NOT leak under WASI.
    expect(result.wat).not.toContain("__str_from_mem");
    expect(result.wat).not.toContain("__str_to_mem");
    const out = new TextDecoder().decode(runWasiCaptureFd(result.binary, 1));
    expect(out).toContain("built with ts2wasm");
  });
});

describe("#1651 process.stdout.write under --target wasi", () => {
  it("writes a string to fd=1 with no trailing newline", () => {
    const src = `declare const process: { stdout: { write(c: Uint8Array | string): void } };
      export function main(): void {
        process.stdout.write("AB");
        process.stdout.write("C");
      }`;
    const result = compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureFd(result.binary, 1);
    // Exactly the three bytes, contiguous, no "\n".
    expect(Array.from(out)).toEqual([0x41, 0x42, 0x43]);
  });

  it("writes a Uint8Array literal (raw bytes incl. non-printable) verbatim", () => {
    const src = `declare const process: { stdout: { write(c: Uint8Array | string): void } };
      export function main(): void {
        process.stdout.write(new Uint8Array([0, 1, 255, 10, 13]));
      }`;
    const result = compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureFd(result.binary, 1);
    expect(Array.from(out)).toEqual([0, 1, 255, 10, 13]);
  });

  it("does not register fd_write for process.stdout.write outside --target wasi", () => {
    const src = `declare const process: { stdout: { write(c: string): void } };
      export function main(): void { process.stdout.write("x"); }`;
    const result = compile(src); // default (gc) target
    if (result.success) {
      expect(result.wat).not.toContain("fd_write");
    }
  });
});
