// #1767 — Native Messaging request handling must remain bounded and non-blocking
// for full-size frames.
//
// The shipped example keeps <=1 MiB messages byte-exact, but larger responses
// must not block waiting for a speculative continuation when the request body is
// exactly 1 MiB. The reported Chrome workload is a JSON Array of nulls, so keep
// the large-array stress shape as a bounded-memory regression.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "examples", "native-messaging", "nm_js2wasm_node_fs.ts");
const ONE_MIB = 1024 * 1024;
const ARRAY_ELEMENTS_PER_MIB = 209715;
const REPORTED_ARRAY_ELEMENTS = ARRAY_ELEMENTS_PER_MIB * 64;
const REPORTED_STRING_BYTES = 64 * ONE_MIB;
const LARGE_STRING_MEMORY_CAP_BYTES = 512 * ONE_MIB;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  // #2631 — node:fs shim: instantiate it first (owns memory + WASI fd_*), then
  // the user module importing {memory, readSync, writeSync} from the shim.
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

function chunkedFrames(body: Uint8Array): Uint8Array {
  let frameCount = 0;
  let bodyOffset = 0;
  while (bodyOffset < body.length) {
    frameCount++;
    bodyOffset += Math.min(ONE_MIB, body.length - bodyOffset);
  }

  const out = new Uint8Array(body.length + frameCount * 4);
  let outOffset = 0;
  bodyOffset = 0;
  while (bodyOffset < body.length) {
    const len = Math.min(ONE_MIB, body.length - bodyOffset);
    new DataView(out.buffer, outOffset, 4).setUint32(0, len, true);
    outOffset += 4;
    out.set(body.subarray(bodyOffset, bodyOffset + len), outOffset);
    outOffset += len;
    bodyOffset += len;
  }
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

type StdinSource = {
  readInto(buffer: ArrayBuffer, ptr: number, len: number): number;
};

function nullArrayBodyBytes(elements: number): number {
  return elements === 0 ? 2 : elements * 5 + 1;
}

function nullArrayByteAt(offset: number, elements: number): number {
  const bodyBytes = nullArrayBodyBytes(elements);
  if (offset === 0) return 91;
  if (offset === bodyBytes - 1) return 93;
  if (elements === 0) throw new Error(`invalid null-array offset ${offset}`);

  const bodyOffset = offset - 1;
  if (bodyOffset < 4) return "null".charCodeAt(bodyOffset);

  const repeatedOffset = bodyOffset - 4;
  const repeatedByte = repeatedOffset % 5;
  return repeatedByte === 0 ? 44 : "null".charCodeAt(repeatedByte - 1);
}

function createNullArrayFrameSource(elements: number, frameBodyLimit: number): StdinSource {
  const totalBodyBytes = nullArrayBodyBytes(elements);
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
          for (let i = 0; i < n; i++) out[written + i] = nullArrayByteAt(payloadOffset + i, elements);
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

type NullArrayRun = {
  frameLengths: number[];
  responseArrayElements: number;
  invalidArrayFrames: number;
  maxFrameBodyBytes: number;
  memoryBytes: number;
  partialHeaderBytes: number;
  remainingFrameBodyBytes: number;
};

function createLargeStringFrameSource(contentBytes: number): StdinSource {
  const declaredLen = contentBytes + 2;
  const header = Uint8Array.from([
    declaredLen & 0xff,
    (declaredLen >> 8) & 0xff,
    (declaredLen >> 16) & 0xff,
    (declaredLen >> 24) & 0xff,
  ]);
  let offset = 0;
  const totalBytes = 4 + declaredLen;

  const byteAt = (pos: number): number => {
    if (pos < 4) return header[pos];
    if (pos === 4 || pos === totalBytes - 1) return 34;
    return 97;
  };

  return {
    readInto(buffer: ArrayBuffer, ptr: number, len: number): number {
      const out = new Uint8Array(buffer, ptr, len);
      const n = Math.min(len, totalBytes - offset);
      for (let i = 0; i < n; i++) out[i] = byteAt(offset + i);
      offset += n;
      return n;
    },
  };
}

type LargeStringRun = {
  frameLengths: number[];
  responseStringBytes: number;
  invalidStringFrames: number;
  maxFrameBodyBytes: number;
  memoryBytes: number;
  partialHeaderBytes: number;
  remainingFrameBodyBytes: number;
};

function runHostWithLargeStringInput(binary: Uint8Array, contentBytes: number): LargeStringRun {
  const source = createLargeStringFrameSource(contentBytes);
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const header = new Uint8Array(4);
  let headerOffset = 0;
  let bodyRemaining = 0;
  let currentFrameIndex = 0;
  let currentFrameLength = 0;
  let currentFrameInvalid = false;
  let responseStringBytes = 0;
  let invalidStringFrames = 0;
  const frameLengths: number[] = [];
  let maxFrameBodyBytes = 0;

  const finishStringFrame = () => {
    if (currentFrameInvalid || currentFrameLength < 2) invalidStringFrames++;
  };

  const scanStringBytes = (chunk: Uint8Array, offset: number, length: number) => {
    for (let i = 0; i < length; i++) {
      const index = currentFrameIndex;
      const byte = chunk[offset + i];
      if (index === 0 || index === currentFrameLength - 1) {
        if (byte !== 34) currentFrameInvalid = true;
      } else {
        if (byte !== 97) currentFrameInvalid = true;
        responseStringBytes++;
      }
      currentFrameIndex++;
    }
  };

  const consumeStdout = (chunk: Uint8Array) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (bodyRemaining > 0) {
        const n = Math.min(bodyRemaining, chunk.length - offset);
        scanStringBytes(chunk, offset, n);
        bodyRemaining -= n;
        offset += n;
        if (bodyRemaining === 0) finishStringFrame();
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
        currentFrameLength = len;
        currentFrameIndex = 0;
        currentFrameInvalid = false;
        headerOffset = 0;
        if (len === 0) finishStringFrame();
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

  // #2631 — node:fs shim: instantiate it first (owns memory + WASI fd_*), then
  // the user module importing {memory, readSync, writeSync} from the shim.
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
    frameLengths,
    responseStringBytes,
    invalidStringFrames,
    maxFrameBodyBytes,
    memoryBytes: ref.mem.buffer.byteLength,
    partialHeaderBytes: headerOffset,
    remainingFrameBodyBytes: bodyRemaining,
  };
}

function runHostWithNullArrayInput(binary: Uint8Array, elements: number): NullArrayRun {
  const source = createNullArrayFrameSource(elements, ONE_MIB);
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const header = new Uint8Array(4);
  let headerOffset = 0;
  let bodyRemaining = 0;
  let scannerState = 0;
  let scannerInvalid = false;
  let responseArrayElements = 0;
  let invalidArrayFrames = 0;
  const frameLengths: number[] = [];
  let maxFrameBodyBytes = 0;

  const startArrayScanner = () => {
    scannerState = 0;
    scannerInvalid = false;
  };
  const finishArrayScanner = () => {
    if (scannerInvalid || scannerState !== 7) invalidArrayFrames++;
  };
  const scanArrayBytes = (chunk: Uint8Array, offset: number, length: number) => {
    const end = offset + length;
    for (let i = offset; i < end; i++) {
      const byte = chunk[i];
      if (scannerInvalid) continue;

      if (scannerState === 0) {
        if (byte === 91) scannerState = 1;
        else scannerInvalid = true;
      } else if (scannerState === 1) {
        if (byte === 93) scannerState = 7;
        else if (byte === 110) scannerState = 2;
        else scannerInvalid = true;
      } else if (scannerState === 2) {
        if (byte === 117) scannerState = 3;
        else scannerInvalid = true;
      } else if (scannerState === 3) {
        if (byte === 108) scannerState = 4;
        else scannerInvalid = true;
      } else if (scannerState === 4) {
        if (byte === 108) {
          responseArrayElements++;
          scannerState = 5;
        } else {
          scannerInvalid = true;
        }
      } else if (scannerState === 5) {
        if (byte === 44) scannerState = 1;
        else if (byte === 93) scannerState = 7;
        else scannerInvalid = true;
      } else {
        scannerInvalid = true;
      }
    }
  };

  const consumeStdout = (chunk: Uint8Array) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (bodyRemaining > 0) {
        const n = Math.min(bodyRemaining, chunk.length - offset);
        scanArrayBytes(chunk, offset, n);
        bodyRemaining -= n;
        offset += n;
        if (bodyRemaining === 0) finishArrayScanner();
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
        startArrayScanner();
        if (len === 0) finishArrayScanner();
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

  // #2631 — node:fs shim: instantiate it first (owns memory + WASI fd_*), then
  // the user module importing {memory, readSync, writeSync} from the shim.
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
    frameLengths,
    responseArrayElements,
    invalidArrayFrames,
    maxFrameBodyBytes,
    memoryBytes: ref.mem.buffer.byteLength,
    partialHeaderBytes: headerOffset,
    remainingFrameBodyBytes: bodyRemaining,
  };
}

describe("#1767 Native Messaging bounded large-response frames", () => {
  it("splits a 1 MiB + 1 raw byte body into <=1 MiB frames", async () => {
    const binary = await compileHost();
    const body = new Uint8Array(ONE_MIB + 1);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;

    const frames = parseFrames(runWasiRaw(binary, chunkedFrames(body)));
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

  it("echoes the exact Chrome Array(209715) 1 MiB frame without waiting for another header", async () => {
    const binary = await compileHost();
    const elements = ARRAY_ELEMENTS_PER_MIB;
    const body = nullArrayBody(elements);
    expect(body.length).toBe(ONE_MIB);

    const frames = parseFrames(runWasiRaw(binary, chunkedFrames(body)));
    expect(frames.map((chunk) => chunk.length)).toEqual([ONE_MIB]);

    const message = JSON.parse(decoder.decode(frames[0]));
    expect(Array.isArray(message)).toBe(true);
    expect(message.length).toBe(elements);
  });

  it("completes the reported 64x Chrome null-array workload with bounded memory", async () => {
    const run = runHostWithNullArrayInput(await compileHost(), REPORTED_ARRAY_ELEMENTS);
    expect(run.frameLengths).toHaveLength(64);
    expect(run.frameLengths.every((len) => len <= ONE_MIB)).toBe(true);
    expect(run.maxFrameBodyBytes).toBe(ONE_MIB);
    expect(run.partialHeaderBytes).toBe(0);
    expect(run.remainingFrameBodyBytes).toBe(0);
    expect(run.memoryBytes).toBeLessThanOrEqual(8 * ONE_MIB);
  }, 180_000);

  it("streams a single 64 MiB JSON string frame without exceeding the 512 MiB memory cap", async () => {
    const run = runHostWithLargeStringInput(await compileHost(), REPORTED_STRING_BYTES);
    expect(run.responseStringBytes).toBe(REPORTED_STRING_BYTES);
    expect(run.frameLengths.every((len) => len <= ONE_MIB)).toBe(true);
    expect(run.maxFrameBodyBytes).toBe(ONE_MIB);
    expect(run.partialHeaderBytes).toBe(0);
    expect(run.remainingFrameBodyBytes).toBe(0);
    expect(run.invalidStringFrames).toBe(0);
    expect(run.memoryBytes).toBeLessThanOrEqual(LARGE_STRING_MEMORY_CAP_BYTES);
  }, 180_000);
});
