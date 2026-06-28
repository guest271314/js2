// #1753 — Native Messaging requests/responses stream as <=1 MiB frames.
//
// The example host must accept a large request split across successive framed
// stdin messages, concatenate it up to the 64 MiB ceiling, and write the echoed
// response back as <=1 MiB framed stdout chunks. The 64 MiB test uses virtual
// stdin and streaming stdout verification so the JS harness does not retain the
// whole request and response bodies at once.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "examples", "native-messaging", "nm_js2wasm_node_fs.ts");
const ONE_MIB = 1024 * 1024;
const SIXTY_FOUR_MIB = 64 * ONE_MIB;

let hostBinary: Promise<Uint8Array> | undefined;

async function compileHost(): Promise<Uint8Array> {
  if (!hostBinary) {
    hostBinary = (async () => {
      const src = readFileSync(hostPath, "utf-8");
      const result = await compile(src, { fileName: "nm_js2wasm_node_fs.ts", target: "wasi", link: ["node:fs"] });
      expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
      return result.binary;
    })();
  }
  return hostBinary;
}

function patternByte(offset: number): number {
  return offset % 251;
}

type StdinSource = {
  readInto(buffer: ArrayBuffer, ptr: number, len: number): number;
};

function createPatternFrameSource(totalBodyBytes: number, frameBodyLimit: number): StdinSource {
  let payloadOffset = 0;
  let frameBodyRemaining = 0;
  let header = new Uint8Array(4);
  let headerOffset = 4;

  const startFrame = () => {
    const len = Math.min(frameBodyLimit, totalBodyBytes - payloadOffset);
    header = Uint8Array.from([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]);
    headerOffset = 0;
    frameBodyRemaining = len;
  };

  return {
    readInto(buffer: ArrayBuffer, ptr: number, len: number): number {
      const out = new Uint8Array(buffer, ptr, len);
      let written = 0;

      while (written < len) {
        if (headerOffset < 4) {
          const n = Math.min(4 - headerOffset, len - written);
          out.set(header.subarray(headerOffset, headerOffset + n), written);
          headerOffset += n;
          written += n;
          continue;
        }

        if (frameBodyRemaining > 0) {
          const n = Math.min(frameBodyRemaining, len - written);
          for (let i = 0; i < n; i++) out[written + i] = patternByte(payloadOffset + i);
          payloadOffset += n;
          frameBodyRemaining -= n;
          written += n;
          continue;
        }

        if (payloadOffset >= totalBodyBytes) break;
        startFrame();
      }

      return written;
    },
  };
}

type HostRun = {
  bodyBytes: number;
  firstMismatch: number;
  frameLengths: number[];
  maxFrameBodyBytes: number;
  memoryBytes: number;
  partialHeaderBytes: number;
  remainingFrameBodyBytes: number;
};

function runHostWithPatternInput(binary: Uint8Array, totalBodyBytes: number): HostRun {
  const source = createPatternFrameSource(totalBodyBytes, ONE_MIB);
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const header = new Uint8Array(4);
  let headerOffset = 0;
  let bodyRemaining = 0;
  let bodyBytes = 0;
  let firstMismatch = -1;
  const frameLengths: number[] = [];
  let maxFrameBodyBytes = 0;

  const consumeStdout = (chunk: Uint8Array) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (bodyRemaining > 0) {
        const n = Math.min(bodyRemaining, chunk.length - offset);
        for (let i = 0; i < n; i++) {
          const expected = patternByte(bodyBytes + i);
          if (firstMismatch < 0 && chunk[offset + i] !== expected) firstMismatch = bodyBytes + i;
        }
        bodyBytes += n;
        bodyRemaining -= n;
        offset += n;
        continue;
      }

      const n = Math.min(4 - headerOffset, chunk.length - offset);
      header.set(chunk.subarray(offset, offset + n), headerOffset);
      headerOffset += n;
      offset += n;

      if (headerOffset === 4) {
        const len = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
        frameLengths.push(len);
        maxFrameBodyBytes = Math.max(maxFrameBodyBytes, len);
        bodyRemaining = len;
        headerOffset = 0;
      }
    }
  };

  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const view = new DataView(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const n = source.readInto(ref.mem!.buffer, ptr, len);
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
        if (fd === 1) consumeStdout(new Uint8Array(ref.mem!.buffer, ptr, len));
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

  // #2631 — the host uses node:fs readSync/writeSync via the node:fs shim.
  // Instantiate the shim first (it owns the memory + makes the WASI fd_* calls),
  // then the user module importing {memory, readSync, writeSync} from the shim.
  const shim = new WebAssembly.Instance(new WebAssembly.Module(buildNodeFsShim()), {
    wasi_snapshot_preview1: wasi,
  });
  ref.mem = shim.exports.memory as WebAssembly.Memory;
  const inst = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    "node:fs": {
      memory: shim.exports.memory,
      readSync: shim.exports.readSync,
      writeSync: shim.exports.writeSync,
    },
    env: {},
  });
  (inst.exports.main as () => void)();

  return {
    bodyBytes,
    firstMismatch,
    frameLengths,
    maxFrameBodyBytes,
    memoryBytes: ref.mem.buffer.byteLength,
    partialHeaderBytes: headerOffset,
    remainingFrameBodyBytes: bodyRemaining,
  };
}

describe("#1753 Native Messaging 64 MiB chunked streaming", () => {
  it("round-trips an exact 1 MiB request as one <=1 MiB frame", async () => {
    const run = runHostWithPatternInput(await compileHost(), ONE_MIB);
    expect(run.frameLengths).toEqual([ONE_MIB]);
    expect(run.bodyBytes).toBe(ONE_MIB);
    expect(run.firstMismatch).toBe(-1);
    expect(run.partialHeaderBytes).toBe(0);
    expect(run.remainingFrameBodyBytes).toBe(0);
  });

  it("reassembles a 1 MiB + 1 request and chunks the response", async () => {
    const run = runHostWithPatternInput(await compileHost(), ONE_MIB + 1);
    expect(run.frameLengths).toEqual([ONE_MIB, 1]);
    expect(run.bodyBytes).toBe(ONE_MIB + 1);
    expect(run.firstMismatch).toBe(-1);
    expect(run.maxFrameBodyBytes).toBe(ONE_MIB);
    expect(run.partialHeaderBytes).toBe(0);
    expect(run.remainingFrameBodyBytes).toBe(0);
  });

  it("round-trips 64 MiB as byte-exact <=1 MiB frames without 64 MiB linear-memory staging", async () => {
    const run = runHostWithPatternInput(await compileHost(), SIXTY_FOUR_MIB);
    expect(run.frameLengths).toHaveLength(64);
    expect(run.frameLengths.every((len) => len <= ONE_MIB)).toBe(true);
    expect(run.maxFrameBodyBytes).toBe(ONE_MIB);
    expect(run.bodyBytes).toBe(SIXTY_FOUR_MIB);
    expect(run.firstMismatch).toBe(-1);
    expect(run.partialHeaderBytes).toBe(0);
    expect(run.remainingFrameBodyBytes).toBe(0);
    expect(run.memoryBytes).toBeLessThanOrEqual(8 * ONE_MIB);
  }, 180_000);
});
