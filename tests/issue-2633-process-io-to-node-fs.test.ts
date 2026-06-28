// #2633 — std-IO routes through `node:fs` (fd-based readSync/writeSync) under
// `--link node:fs`; the bespoke `js2wasm:node-process` shim is retired and
// the hallucinated `process.stdin.read(buf, offset)` is no longer recognised.
//
// Under `--target wasi --link node:fs`, a module that writes to stdout/stderr
// (console.log/warn/error, process.stdout/stderr.write) imports the `node:fs`
// interface (writeSync) plus its linear memory from `node:fs` and carries NO
// `wasi_snapshot_preview1` import and NO `js2wasm:node-process` import for the
// stream IO path. `node-fs.wasm` implements that interface over WASI.
//
// These tests assert (1) the import shape (node:fs, not node-process), (2)
// flag-off parity (inline fd_write), (3) that `process.stdin.read` is rejected
// with a message pointing at `node:fs` readSync, and (4) a real link + round-trip
// of `process.stdout.write` through the node:fs shim.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

const DECL = `declare const process: {
  stdin: { read(buf: Uint8Array | ArrayBuffer, offset?: number): number };
  stdout: { write(c: Uint8Array): boolean };
  stderr: { write(c: Uint8Array): boolean };
};`;

// Echo a fixed Uint8Array to stdout via process.stdout.write — exercises the
// std-IO *write* path that now lowers to node:fs writeSync(1, …).
const ECHO_WRITE = `${DECL}
  export function main(): void {
    const msg = new Uint8Array([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
    process.stdout.write(msg);
  }`;

/**
 * Link the node:fs shim + the user module and capture fd=1 bytes. The shim owns
 * the memory; the user module imports {memory, readSync, writeSync} from it. A
 * minimal WASI fd_write records the bytes — exactly like a real host.
 */
function linkAndRun(userBinary: Uint8Array): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const memView = () => new DataView(ref.mem!.buffer);
  const captured: number[] = [];
  const wasi = {
    fd_read(_fd: number, _iovs: number, _iovsLen: number, nread: number): number {
      memView().setUint32(nread, 0, true);
      return 0;
    },
    fd_write(wfd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = memView();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        if (wfd === 1) for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) captured.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
  };
  // Instantiate the shim FIRST (it imports only wasi_snapshot_preview1), then the
  // user with {memory + io fns} from the shim — no instantiation cycle.
  const shim = new WebAssembly.Instance(new WebAssembly.Module(buildNodeFsShim()), {
    wasi_snapshot_preview1: wasi,
  });
  ref.mem = shim.exports.memory as WebAssembly.Memory;
  const user = new WebAssembly.Instance(new WebAssembly.Module(userBinary), {
    "node:fs": {
      memory: shim.exports.memory,
      readSync: shim.exports.readSync,
      writeSync: shim.exports.writeSync,
    },
    env: {},
  });
  (user.exports.main as () => void)();
  return Uint8Array.from(captured);
}

describe("#2633 — std-IO via node:fs (node-process shim retired)", () => {
  it("process.stdout.write lowers to node:fs writeSync, NOT js2wasm:node-process", async () => {
    const result = await compile(ECHO_WRITE, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const wat = result.wat ?? "";
    // Imports the node:fs interface: memory + writeSync.
    expect(wat).toContain('(import "node:fs" "memory" (memory');
    expect(wat).toContain('(import "node:fs" "writeSync"');
    // The retired bespoke shim is GONE.
    expect(wat).not.toContain("js2wasm:node-process");
    expect(wat).not.toContain("stdout_write");
    expect(wat).not.toContain("stderr_write");
    expect(wat).not.toContain("stdin_read");
    // NO wasi_snapshot_preview1 import survives for the stream IO path.
    expect(wat).not.toContain("wasi_snapshot_preview1");
    // The user module imports its memory (does not own/export it).
    expect(wat).not.toContain('(export "memory"');
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("console.log lowers to node:fs writeSync(1, …) under --link node:fs", async () => {
    const src = `export function main(): void { console.log("hi"); }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).toContain('(import "node:fs" "writeSync"');
    expect(wat).not.toContain("js2wasm:node-process");
  });

  it("console.error lowers to node:fs writeSync(2, …) under --link node:fs", async () => {
    const src = `export function main(): void { console.error("boom"); }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).toContain('(import "node:fs" "writeSync"');
    expect(wat).not.toContain("js2wasm:node-process");
  });

  it("default (flag off) keeps the inline wasi_snapshot_preview1 fd_write path", async () => {
    const result = await compile(ECHO_WRITE, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).toContain("wasi_snapshot_preview1");
    expect(wat).toContain("fd_write");
    // Inline path declares + exports its own memory.
    expect(wat).toContain('(export "memory"');
    expect(wat).not.toContain("js2wasm:node-process");
    expect(wat).not.toContain('(import "node:fs"');
  });

  it("process.stdin.read(buf, offset) is rejected with a pointer to node:fs readSync", async () => {
    const src = `${DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        process.stdin.read(buf, 0);
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(false);
    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toContain("process.stdin.read");
    expect(msg).toContain("not a real Node API");
    expect(msg).toContain("readSync");
    expect(msg).toContain("node:fs");
  });

  it("process.stdin.read is also rejected on the inline (flag-off) WASI path", async () => {
    const src = `${DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        process.stdin.read(buf, 0);
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain("readSync");
  });

  it("links node-fs.wasm and round-trips process.stdout.write byte-for-byte", async () => {
    const result = await compile(ECHO_WRITE, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const out = linkAndRun(result.binary);
    expect(Array.from(out)).toEqual([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
  });

  it("link: ['node:fs'] is ignored for non-WASI targets (no node shim imports)", async () => {
    const src = `export function add(a: number, b: number): number { return a + b; }`;
    const result = await compile(src, { fileName: "x.ts", link: ["node:fs"] });
    expect(result.success).toBe(true);
    expect(result.wat ?? "").not.toContain("js2wasm:node-process");
    expect(result.wat ?? "").not.toContain('(import "node:fs"');
  });
});
