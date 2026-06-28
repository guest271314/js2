import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

// #2633 — synchronous stdin is `node:fs` `readSync(0, …)` (the hallucinated
// `process.stdin.read` surface was removed). `readSync`/`writeSync` are
// supported under `--link node:fs`; the shim owns the WASI fd_read/fd_write.
describe("WASI stdin via fd_read (#1653/#2633)", () => {
  it("imports node:fs readSync when readSync(0, …) is used (--link node:fs)", async () => {
    const result = await compile(
      `
      import { readSync, writeSync } from "node:fs";
      export function main(): void {
        const buf = new Uint8Array(4);
        const n = readSync(0, buf, 0, 4);
        writeSync(1, buf);
      }
      `,
      { target: "wasi", link: ["node:fs"] },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // The user module imports the node:fs interface; the shim owns fd_read.
    expect(result.wat).toContain('(import "node:fs" "readSync"');
    expect(result.wat).not.toContain("js2wasm:node-process");
    expect(result.binary.length).toBeGreaterThan(0);
  });

  it("does NOT register fd_read when readSync is not used", async () => {
    const result = await compile(`console.log("no stdin here");`, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("fd_read");
  });

  it("process.stdin.read(buf, offset) is rejected (no real Node API)", async () => {
    const result = await compile(
      `
      declare const process: { stdin: { read(buf: Uint8Array, offset?: number): number } };
      export function main(): void {
        const buf = new Uint8Array(4);
        process.stdin.read(buf, 0);
      }
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain("readSync");
  });

  it("buildWasiPolyfill exposes fd_read and setStdin", () => {
    const wasi = buildWasiPolyfill();
    expect(typeof wasi.fd_read).toBe("function");
    expect(typeof wasi.setStdin).toBe("function");

    // fd_read with no memory set returns -1 (error)
    expect(wasi.fd_read(0, 0, 1, 8)).toBe(-1);

    // Stdin can be preloaded as string or bytes (no throw)
    wasi.setStdin("hello\n");
    wasi.setStdin(new Uint8Array([1, 2, 3]));
  });

  it("fd_read polyfill drains preloaded stdin into linear memory", () => {
    const wasi = buildWasiPolyfill();
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.setMemory(memory);
    wasi.setStdin("ab");

    const view = new DataView(memory.buffer);
    // iovec @ 0: buf=64, len=8 ; nread @ 16
    view.setUint32(0, 64, true);
    view.setUint32(4, 8, true);

    const errno = wasi.fd_read(0, 0, 1, 16);
    expect(errno).toBe(0);
    expect(view.getUint32(16, true)).toBe(2);
    expect(view.getUint8(64)).toBe(97); // 'a'
    expect(view.getUint8(65)).toBe(98); // 'b'

    // Subsequent read returns EOF (nread = 0)
    view.setUint32(0, 64, true);
    view.setUint32(4, 8, true);
    expect(wasi.fd_read(0, 0, 1, 16)).toBe(0);
    expect(view.getUint32(16, true)).toBe(0);
  });
});
