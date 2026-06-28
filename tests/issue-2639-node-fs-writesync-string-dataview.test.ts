// #2639 — node:fs writeSync(fd, str | DataView) codegen.
//
// The #2634 capability map declares TWO writeSync overloads — a buffer form and
// a STRING form (writeSync(fd, str, position?, encoding?)) — plus DataView is
// part of __NodeFsArrayBufferView. But only the Uint8Array/ArrayBuffer buffer
// arm was lowered: a string or DataView arg type-checked, compiled, and then
// wrote ZERO bytes (the GC-$Vec resolver returned null and the codegen emitted a
// `0` byte count). This closes that gap:
//   - string  → encode to UTF-8 (same WTF-16→UTF-8 encoder process.std*.write
//               uses) and write to the runtime fd via the node:fs writeSync shim.
//   - DataView → resolve its i32_byte backing + byteOffset/byteLength to a
//               (ptr, len) over the write scratch, then write that range.
// utf8 is the default and only supported string encoding under --target wasi;
// an explicit non-utf8 encoding is a clear compile error.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

/** Link the node-fs shim + the user module, run main(), capture fd 1 / fd 2. */
function linkAndRun(userBinary: Uint8Array): { stdout: Uint8Array; stderr: Uint8Array } {
  const shimBinary = buildNodeFsShim();
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const memView = () => new DataView(ref.mem!.buffer);
  const out1: number[] = [];
  const out2: number[] = [];
  const wasi = {
    fd_read(): number {
      return 0;
    },
    fd_write(wfd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = memView();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(ref.mem!.buffer, ptr, len);
        if (wfd === 1) for (const b of bytes) out1.push(b);
        else if (wfd === 2) for (const b of bytes) out2.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
  };
  const shim = new WebAssembly.Instance(new WebAssembly.Module(shimBinary), {
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
  return { stdout: Uint8Array.from(out1), stderr: Uint8Array.from(out2) };
}

async function compileWasi(src: string) {
  return compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
}

describe("#2639 — node:fs writeSync string + DataView codegen", () => {
  it("writeSync(1, str) / writeSync(2, str) emit the UTF-8 bytes to the right fd", async () => {
    const src = `
import { writeSync } from "node:fs";
export function main(): void {
  writeSync(1, "hi\\n");
  writeSync(2, "err\\n");
}
`;
    const result = await compileWasi(src);
    expect(result.success).toBe(true);
    const { stdout, stderr } = linkAndRun(result.binary);
    expect(Buffer.from(stdout).toString("utf8")).toBe("hi\n");
    expect(Buffer.from(stderr).toString("utf8")).toBe("err\n");
  });

  it("encodes non-ASCII strings (multi-byte + astral) as UTF-8", async () => {
    const src = `
import { writeSync } from "node:fs";
export function main(): void {
  writeSync(1, "héllo→\\u{1F600}");
}
`;
    const result = await compileWasi(src);
    expect(result.success).toBe(true);
    const { stdout } = linkAndRun(result.binary);
    const expected = "héllo→😀";
    expect(Buffer.from(stdout).toString("utf8")).toBe(expected);
    // Byte count equals UTF-8 length, not UTF-16 code-unit count.
    expect(stdout.length).toBe(Buffer.byteLength(expected, "utf8"));
  });

  it("handles a runtime (rope) string, not just a literal", async () => {
    const src = `
import { writeSync } from "node:fs";
export function main(): void {
  const a = "ab";
  const b = "cd";
  writeSync(1, a + b + "\\n");
}
`;
    const result = await compileWasi(src);
    expect(result.success).toBe(true);
    const { stdout } = linkAndRun(result.binary);
    expect(Buffer.from(stdout).toString("utf8")).toBe("abcd\n");
  });

  it("accepts an explicit utf8 encoding arg (position?, encoding?)", async () => {
    const src = `
import { writeSync } from "node:fs";
export function main(): void {
  writeSync(1, "ok", null, "utf8");
  writeSync(1, "!", null, "utf-8");
}
`;
    const result = await compileWasi(src);
    expect(result.success).toBe(true);
    const { stdout } = linkAndRun(result.binary);
    expect(Buffer.from(stdout).toString("utf8")).toBe("ok!");
  });

  it("rejects an explicit non-utf8 encoding with a clear diagnostic", async () => {
    const src = `
import { writeSync } from "node:fs";
export function main(): void {
  writeSync(1, "x", null, "hex");
}
`;
    const result = await compileWasi(src);
    expect(result.success).toBe(false);
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).toMatch(/utf8/);
    expect(msgs).toMatch(/hex/);
  });

  it("writeSync(1, dataView) writes the full backing range", async () => {
    const src = `
import { writeSync } from "node:fs";
export function main(): void {
  const b = new ArrayBuffer(3);
  const dv = new DataView(b);
  dv.setUint8(0, 0x61); // 'a'
  dv.setUint8(1, 0x62); // 'b'
  dv.setUint8(2, 0x63); // 'c'
  writeSync(1, dv);
}
`;
    const result = await compileWasi(src);
    expect(result.success).toBe(true);
    const { stdout } = linkAndRun(result.binary);
    expect(Buffer.from(stdout).toString("utf8")).toBe("abc");
  });

  it("honours a windowed DataView's byteOffset/byteLength (writes only that range)", async () => {
    const src = `
import { writeSync } from "node:fs";
export function main(): void {
  const b = new ArrayBuffer(5);
  const full = new DataView(b);
  full.setUint8(0, 0x41); // 'A'
  full.setUint8(1, 0x42); // 'B'
  full.setUint8(2, 0x43); // 'C'
  full.setUint8(3, 0x44); // 'D'
  full.setUint8(4, 0x45); // 'E'
  const win = new DataView(b, 1, 3); // bytes 1..3 → "BCD"
  writeSync(1, win);
}
`;
    const result = await compileWasi(src);
    expect(result.success).toBe(true);
    const { stdout } = linkAndRun(result.binary);
    expect(Buffer.from(stdout).toString("utf8")).toBe("BCD");
  });

  it("does not regress the Uint8Array buffer overload", async () => {
    const src = `
import { writeSync } from "node:fs";
export function main(): void {
  const u = new Uint8Array(2);
  u[0] = 0x68; // 'h'
  u[1] = 0x69; // 'i'
  let n = 0;
  while (n < u.length) {
    const w = writeSync(1, u, n);
    if (w <= 0) break;
    n = n + w;
  }
}
`;
    const result = await compileWasi(src);
    expect(result.success).toBe(true);
    const { stdout } = linkAndRun(result.binary);
    expect(Buffer.from(stdout).toString("utf8")).toBe("hi");
  });
});
