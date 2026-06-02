import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function runWasiCaptureFd(binary: Uint8Array, fd: number): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const captured: number[] = [];
  const view = () => new DataView(ref.mem!.buffer);
  const wasi = {
    fd_write(wfd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const memView = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = memView.getUint32(iovs + i * 8, true);
        const len = memView.getUint32(iovs + i * 8 + 4, true);
        if (wfd === fd) for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) captured.push(b);
        total += len;
      }
      memView.setUint32(nwritten, total, true);
      return 0;
    },
    fd_read(_fd: number, _iovs: number, _iovsLen: number, nread: number): number {
      view().setUint32(nread, 0, true);
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

describe("#1766 process stdout/stderr synchronous WASI stream compatibility", () => {
  it("returns true from process.stdout.write and compiles once('drain') without host EventEmitter imports", async () => {
    const src = `import process from "node:process";

    export function main(): void {
      if (!process.stdout.write(new Uint8Array([65]))) {
        process.stdout.once("drain", () => {
          process.stdout.write(new Uint8Array([66]));
        });
      }
    }`;

    const result = await compile(src, { fileName: "issue-1766.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("__extern_method_call");
    expect(result.wat).not.toContain("__extern_get_method");
    expect(result.wat).not.toContain("__node_process");
    expect(Array.from(runWasiCaptureFd(result.binary, 1))).toEqual([65]);
  });

  it("returns true from string writes too", async () => {
    const src = `declare const process: {
      stdout: { write(chunk: Uint8Array | string): boolean };
    };

    export function main(): void {
      if (process.stdout.write("A")) {
        process.stdout.write("B");
      }
    }`;

    const result = await compile(src, { fileName: "issue-1766-string.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(new TextDecoder().decode(runWasiCaptureFd(result.binary, 1))).toBe("AB");
  });
});
