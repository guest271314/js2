// #1767 — Native Messaging large responses must be bounded to <=1 MiB frames.
//
// The shipped example keeps <=1 MiB messages byte-exact, but larger responses
// must avoid one oversized stdout write/staging region. The reported Chrome
// workload is a JSON Array of nulls, so the large-array path also needs each
// response frame to be valid JSON that Chrome can deliver to port.onMessage.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "examples", "native-messaging", "nm_js2wasm.ts");
const ONE_MIB = 1024 * 1024;
const ARRAY_ELEMENTS_PER_MIB = 209715;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let hostBinary: Promise<Uint8Array> | undefined;

async function compileHost(): Promise<Uint8Array> {
  if (!hostBinary) {
    hostBinary = (async () => {
      const src = readFileSync(hostPath, "utf-8");
      const result = await compile(src, { fileName: "nm_js2wasm.ts", target: "wasi" });
      expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
      return result.binary;
    })();
  }
  return hostBinary;
}

function runWasiRaw(binary: Uint8Array, stdin: Uint8Array): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const writes: Array<[number, Uint8Array]> = [];
  let pos = 0;
  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const view = new DataView(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, stdin.length - pos);
        new Uint8Array(ref.mem!.buffer, ptr, n).set(stdin.subarray(pos, pos + n));
        pos += n;
        total += n;
        if (n < len) break;
      }
      view.setUint32(nread, total, true);
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = new DataView(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        writes.push([fd, Uint8Array.from(new Uint8Array(ref.mem!.buffer, ptr, len))]);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(code: number): void {
      throw new Error(`proc_exit(${code})`);
    },
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

  const fd1 = writes.filter(([fd]) => fd === 1).map(([, bytes]) => bytes);
  const total = fd1.reduce((n, bytes) => n + bytes.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const bytes of fd1) {
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}

function frame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

function parseFrames(out: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < out.length) {
    expect(offset + 4).toBeLessThanOrEqual(out.length);
    const len = new DataView(out.buffer, out.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    expect(offset + len).toBeLessThanOrEqual(out.length);
    frames.push(out.subarray(offset, offset + len));
    offset += len;
  }
  return frames;
}

function nullArrayBody(elements: number): Uint8Array {
  const text = elements === 0 ? "[]" : `[null${",null".repeat(elements - 1)}]`;
  return encoder.encode(text);
}

describe("#1767 Native Messaging bounded large-response frames", () => {
  it("splits a 1 MiB + 1 raw byte body into <=1 MiB frames", async () => {
    const binary = await compileHost();
    const body = new Uint8Array(ONE_MIB + 1);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;

    const frames = parseFrames(runWasiRaw(binary, frame(body)));
    expect(frames.map((chunk) => chunk.length)).toEqual([ONE_MIB, 1]);

    let cursor = 0;
    for (const chunk of frames) {
      for (let i = 0; i < chunk.length; i++) {
        expect(chunk[i]).toBe(body[cursor + i]);
      }
      cursor += chunk.length;
    }
    expect(cursor).toBe(body.length);
  });

  it("splits a Chrome null-array response into valid <=1 MiB JSON array frames", async () => {
    const binary = await compileHost();
    const elements = ARRAY_ELEMENTS_PER_MIB + 1;
    const body = nullArrayBody(elements);
    expect(body.length).toBe(ONE_MIB + 5);

    const frames = parseFrames(runWasiRaw(binary, frame(body)));
    expect(frames.map((chunk) => chunk.length)).toEqual([ONE_MIB, 6]);

    let receivedElements = 0;
    for (const chunk of frames) {
      expect(chunk.length).toBeLessThanOrEqual(ONE_MIB);
      const message = JSON.parse(decoder.decode(chunk));
      expect(Array.isArray(message)).toBe(true);
      receivedElements += message.length;
    }
    expect(receivedElements).toBe(elements);
  });
});
