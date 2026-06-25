// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2045 C.7 (successor) — clamp an EXPLICIT `offset`/`length` on node:fs
 * `readSync`/`writeSync(fd, buf, { offset, length })` to the buffer's element
 * length, so they can never address linear memory past the buffer.
 *
 * The original C.7 concern was `process.stdin.read(buf, off)` (a hallucinated
 * API, since removed — #2633). The concern migrated to the #2655
 * `readSync`/`writeSync(fd, buf, { offset, length })` direct-WASI path: when
 * `length` is ABSENT it defaults to `bufLen - offset` (sound by construction),
 * but an EXPLICIT `offset`/`length` was only `trunc_sat`'d with NO clamp against
 * `bufLen`. So `writeSync(1, b, { length: 64 })` on a 4-byte buffer read 60 bytes
 * of arbitrary linear memory past the buffer (OOB read / info leak), and an
 * unclamped readSync `length` wrote the syscall result OOB into linear memory
 * past the destination buffer (the A.2 silent-corruption class).
 *
 * Fix (`node-fs-api.ts:emitNodeFsOffsetLength`): clamp the explicit offset into
 * `[0, bufLen]` and the explicit length into `[0, bufLen - offset]`, guaranteeing
 * `offset + length <= bufLen`. Fail-soft (clamp), matching the surrounding
 * fail-soft style (errno -> 0, the absent-length branch). WASI-only path.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileWasi(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return result.binary;
}

/**
 * Run a WASI module's `main`/`_start`, mocking fd_read from `stdin` and
 * capturing fd_write bytes. Returns the bytes written to fd 1.
 */
async function runWasi(binary: Uint8Array, stdin: number[] = []): Promise<number[]> {
  const module = await WebAssembly.compile(binary);
  const memRef: { value?: WebAssembly.Memory } = {};
  const out: number[] = [];
  let inPos = 0;
  const dv = () => new DataView(memRef.value!.buffer);
  const memU8 = () => new Uint8Array(memRef.value!.buffer);
  const wasi = {
    fd_read(_fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
      const d = dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const p = d.getUint32(base, true);
        const l = d.getUint32(base + 4, true);
        for (let j = 0; j < l && inPos < stdin.length; j++) {
          memU8()[p + j] = stdin[inPos++]!;
          total++;
        }
      }
      d.setUint32(nreadPtr, total, true);
      return 0;
    },
    fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const d = dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const p = d.getUint32(base, true);
        const l = d.getUint32(base + 4, true);
        for (const b of memU8().subarray(p, p + l)) out.push(b);
        total += l;
      }
      d.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    proc_exit: () => {
      throw new Error("__proc_exit");
    },
  };
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  memRef.value = exports.memory as WebAssembly.Memory;
  const entry = (exports.main ?? exports._start) as undefined | (() => void);
  if (!entry) throw new Error("no main/_start export");
  entry();
  return out;
}

describe("#2045 C.7 — readSync/writeSync explicit offset/length clamp", () => {
  // ---- writeSync (OOB read past buffer = info leak) ----

  it("writeSync explicit length > bufLen clamps to bufLen (no OOB read)", async () => {
    const bin = await compileWasi(`import { writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(4);
        b[0] = 1; b[1] = 2; b[2] = 3; b[3] = 4;
        writeSync(1, b, { offset: 0, length: 64 });  // 64 >> 4 — must clamp to 4
      }`);
    expect(await runWasi(bin)).toEqual([1, 2, 3, 4]);
  });

  it("writeSync offset > bufLen clamps to bufLen (writes 0 bytes)", async () => {
    const bin = await compileWasi(`import { writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(4);
        b[0] = 1; b[1] = 2; b[2] = 3; b[3] = 4;
        writeSync(1, b, { offset: 100, length: 4 });  // off 100 >> 4
      }`);
    expect(await runWasi(bin)).toEqual([]);
  });

  it("writeSync offset + length > bufLen clamps length to remaining capacity", async () => {
    const bin = await compileWasi(`import { writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(4);
        b[0] = 10; b[1] = 20; b[2] = 30; b[3] = 40;
        writeSync(1, b, { offset: 2, length: 10 });  // 2 + 10 > 4 — clamp to 2 bytes
      }`);
    expect(await runWasi(bin)).toEqual([30, 40]);
  });

  it("writeSync negative offset clamps to 0", async () => {
    const bin = await compileWasi(`import { writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(4);
        b[0] = 5; b[1] = 6; b[2] = 7; b[3] = 8;
        writeSync(1, b, { offset: -5, length: 2 });
      }`);
    expect(await runWasi(bin)).toEqual([5, 6]);
  });

  it("writeSync negative length clamps to 0", async () => {
    const bin = await compileWasi(`import { writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(4);
        b[0] = 1; b[1] = 2;
        writeSync(1, b, { offset: 0, length: -3 });
      }`);
    expect(await runWasi(bin)).toEqual([]);
  });

  // ---- in-range cases unchanged (no over-clamp) ----

  it("writeSync in-range offset+length writes the exact slice", async () => {
    const bin = await compileWasi(`import { writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(4);
        b[0] = 10; b[1] = 20; b[2] = 30; b[3] = 40;
        writeSync(1, b, { offset: 1, length: 2 });
      }`);
    expect(await runWasi(bin)).toEqual([20, 30]);
  });

  it("writeSync with no options writes the whole buffer (default path unchanged)", async () => {
    const bin = await compileWasi(`import { writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(3);
        b[0] = 7; b[1] = 8; b[2] = 9;
        writeSync(1, b);
      }`);
    expect(await runWasi(bin)).toEqual([7, 8, 9]);
  });

  // ---- readSync (OOB write into linear memory past buffer = corruption) ----

  it("readSync explicit length > bufLen clamps (no OOB write past buffer)", async () => {
    const bin = await compileWasi(`import { readSync, writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(2);
        const n = readSync(0, b, { offset: 0, length: 100 });  // 100 >> 2
        writeSync(1, b);
      }`);
    // Only 2 bytes fit; the rest of stdin must NOT be written past the buffer.
    expect(await runWasi(bin, [5, 6, 7, 8])).toEqual([5, 6]);
  });

  it("readSync into an explicit offset places bytes correctly", async () => {
    const bin = await compileWasi(`import { readSync, writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(6);
        const n = readSync(0, b, { offset: 2, length: 3 });
        writeSync(1, b);
      }`);
    expect(await runWasi(bin, [99, 98, 97])).toEqual([0, 0, 99, 98, 97, 0]);
  });

  it("readSync offset > bufLen clamps (reads 0 bytes into the buffer)", async () => {
    const bin = await compileWasi(`import { readSync, writeSync } from "node:fs";
      export function main(): void {
        const b = new Uint8Array(4);
        const n = readSync(0, b, { offset: 100, length: 4 });
        writeSync(1, b);
      }`);
    expect(await runWasi(bin, [1, 2, 3, 4])).toEqual([0, 0, 0, 0]);
  });
});
