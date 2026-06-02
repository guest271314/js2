import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function expectCompileSuccess(result: Awaited<ReturnType<typeof compile>>): void {
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
}

function importNames(binary: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(binary)).map((i) => `${i.module}.${i.name}`);
}

function expectNoEncodingHostImports(binary: Uint8Array, wat: string): void {
  const imports = importNames(binary).filter((name) => name.includes("TextEncoder") || name.includes("TextDecoder"));
  expect(imports).toEqual([]);
  expect(wat).not.toContain("TextEncoder_");
  expect(wat).not.toContain("TextDecoder_");
}

function instantiate(binary: Uint8Array): WebAssembly.Exports {
  return new WebAssembly.Instance(new WebAssembly.Module(binary), {}).exports;
}

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
        if (wfd === fd) {
          for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) captured.push(b);
        }
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

describe("#1752 TextEncoder/TextDecoder under standalone and WASI", () => {
  it("encodes ASCII, multibyte, and surrogate-pair code points in WASI", async () => {
    const text = "Aé你😀";
    const expected = Array.from(new TextEncoder().encode(text));
    const src = `export function len(): number {
        return new TextEncoder().encode("Aé你😀").length;
      }

      export function byteAt(i: number): number {
        return new TextEncoder().encode("Aé你😀")[i];
      }`;

    const result = await compile(src, { fileName: "issue-1752-encode.ts", target: "wasi" });
    expectCompileSuccess(result);
    expectNoEncodingHostImports(result.binary, result.wat);

    const exports = instantiate(result.binary) as { len: () => number; byteAt: (i: number) => number };
    expect(exports.len()).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(exports.byteAt(i)).toBe(expected[i]);
    }
  });

  it("round-trips TextEncoder.encode through TextDecoder.decode in standalone", async () => {
    const src = `export function ok(): number {
        const s = "ASCII é 你 😀";
        const encoded = new TextEncoder().encode(s);
        return new TextDecoder("utf-8").decode(encoded) === s ? 1 : 0;
      }`;

    const result = await compile(src, { fileName: "issue-1752-roundtrip.ts", target: "standalone" });
    expectCompileSuccess(result);
    expectNoEncodingHostImports(result.binary, result.wat);

    const exports = instantiate(result.binary) as { ok: () => number };
    expect(exports.ok()).toBe(1);
  });

  it("decodes valid UTF-8 byte literals", async () => {
    const src = `export function ok(): number {
        const bytes = new Uint8Array([0x41, 0xc3, 0xa9, 0xe4, 0xbd, 0xa0, 0xf0, 0x9f, 0x98, 0x80]);
        return new TextDecoder().decode(bytes) === "Aé你😀" ? 1 : 0;
      }`;

    const result = await compile(src, { fileName: "issue-1752-decode.ts", target: "wasi" });
    expectCompileSuccess(result);
    expectNoEncodingHostImports(result.binary, result.wat);

    const exports = instantiate(result.binary) as { ok: () => number };
    expect(exports.ok()).toBe(1);
  });

  it("exposes standard default properties without host imports", async () => {
    const src = `export function ok(): number {
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        return enc.encoding === "utf-8" &&
          dec.encoding === "utf-8" &&
          dec.fatal === false &&
          dec.ignoreBOM === false ? 1 : 0;
      }`;

    const result = await compile(src, { fileName: "issue-1752-props.ts", target: "standalone" });
    expectCompileSuccess(result);
    expectNoEncodingHostImports(result.binary, result.wat);

    const exports = instantiate(result.binary) as { ok: () => number };
    expect(exports.ok()).toBe(1);
  });

  it("compiles the stored encoder encodeMessage shape used by WASI stdout", async () => {
    const src = `declare const process: {
        stdout: { write(chunk: Uint8Array | string): void };
      };

      const encoder: TextEncoder = new TextEncoder();

      function encodeMessage(message: string): Uint8Array {
        return encoder.encode(message);
      }

      export function main(): void {
        process.stdout.write(encodeMessage("{\\"received\\":true}"));
      }`;

    const result = await compile(src, { fileName: "issue-1752-wasi-stdout.ts", target: "wasi" });
    expectCompileSuccess(result);
    expectNoEncodingHostImports(result.binary, result.wat);

    const out = runWasiCaptureFd(result.binary, 1);
    expect(new TextDecoder().decode(out)).toBe('{"received":true}');
  });
});
