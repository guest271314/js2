// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3054 C — resizable ArrayBuffer semantics via the `$__resizable_ab` WasmGC
// subtype of `$__vec_i32_byte` (Phase A A.2). `new ArrayBuffer(n, {maxByteLength})`
// allocates the subtype; the subtype IDENTITY is the "resizable" bit
// (`ref.test $__resizable_ab`), so the 23 `i32_byte` read sites are untouched and
// only the resizable-aware sites (ctor, `.resize()`, `.maxByteLength`/`.resizable`
// getters + auto-length view tracking) know it.
//
// Standalone lane only: the native `i32_byte` vec representation of ArrayBuffer
// exists host-free (a host-mode ArrayBuffer is a host object). These are
// HOST-ENFORCED assertions — each program returns a number/flag to JS and vitest
// `expect` enforces it — because the standalone lane does NOT enforce in-Wasm
// numeric asserts (#3055/#3056), so a standalone pass-count is blind to this
// correctness.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

/** Returns true iff the compiled standalone program traps (threw a Wasm exception). */
async function traps(src: string): Promise<boolean> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  try {
    (instance.exports as { f: () => number }).f();
    return false;
  } catch {
    return true;
  }
}

describe("#3054 C resizable ArrayBuffer", () => {
  describe("construction + metadata", () => {
    it("new ArrayBuffer(n, {maxByteLength}) reports maxByteLength", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          return b.maxByteLength;
        }`),
      ).toBe(16);
    });

    it("a resizable buffer reports .resizable === true", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          return b.resizable ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("a non-resizable buffer reports .resizable === false", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8);
          return b.resizable ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("a non-resizable buffer's .maxByteLength === its byteLength (§25.1.5.4)", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8);
          return b.maxByteLength;
        }`),
      ).toBe(8);
    });

    it("byteLength of a resizable buffer is the initial length", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          return b.byteLength;
        }`),
      ).toBe(8);
    });

    it("maxByteLength on an Int32-view-backed buffer is the byte max", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 32 });
          const a = new Int32Array(b);
          return b.maxByteLength;
        }`),
      ).toBe(32);
    });

    it("ctor throws RangeError when byteLength > maxByteLength", async () => {
      expect(
        await traps(`export function f(): number {
          const b = new ArrayBuffer(20, { maxByteLength: 16 });
          return b.byteLength;
        }`),
      ).toBe(true);
    });
  });

  describe("resize()", () => {
    it("grow: byteLength reflects the new (larger) length", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          b.resize(12);
          return b.byteLength;
        }`),
      ).toBe(12);
    });

    it("shrink: byteLength reflects the new (smaller) length", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          b.resize(4);
          return b.byteLength;
        }`),
      ).toBe(4);
    });

    it("resize to 0 is allowed", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          b.resize(0);
          return b.byteLength;
        }`),
      ).toBe(0);
    });

    it("resize exactly to maxByteLength is allowed (boundary)", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          b.resize(16);
          return b.byteLength;
        }`),
      ).toBe(16);
    });

    it("resize past maxByteLength throws RangeError", async () => {
      expect(
        await traps(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          b.resize(20);
          return b.byteLength;
        }`),
      ).toBe(true);
    });

    it("resize on a non-resizable buffer throws TypeError", async () => {
      expect(
        await traps(`export function f(): number {
          const b = new ArrayBuffer(8);
          b.resize(4);
          return b.byteLength;
        }`),
      ).toBe(true);
    });

    it("resize preserves existing bytes (grow keeps [0, min(old,new)))", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          const a = new Uint8Array(b);
          a[3] = 42;
          b.resize(12);
          return a[3];
        }`),
      ).toBe(42);
    });
  });

  describe("length-tracking views over a resizable buffer", () => {
    it("an auto-length view's .length grows with the buffer", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(4, { maxByteLength: 16 });
          const a = new Uint8Array(b);
          b.resize(12);
          return a.length;
        }`),
      ).toBe(12);
    });

    it("an auto-length view's .byteLength tracks a grow", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(4, { maxByteLength: 16 });
          const a = new Uint8Array(b);
          b.resize(12);
          return a.byteLength;
        }`),
      ).toBe(12);
    });

    it("an Int32 auto-length view tracks length in ELEMENTS", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(4, { maxByteLength: 32 });
          const a = new Int32Array(b);
          b.resize(12);
          return a.length;
        }`),
      ).toBe(3); // 12 bytes / 4
    });

    it("writing a newly-available index after grow round-trips", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(4, { maxByteLength: 16 });
          const a = new Uint8Array(b);
          b.resize(12);
          a[10] = 77;
          return a[10];
        }`),
      ).toBe(77);
    });

    it("sibling views over the same resizable buffer both observe grow + write", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(4, { maxByteLength: 16 });
          const a = new Uint8Array(b);
          const c = new Uint8Array(b);
          b.resize(12);
          a[9] = 9;
          return c[9];
        }`),
      ).toBe(9);
    });

    it("reading an out-of-range index after shrink yields NaN (OOB → undefined)", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(12, { maxByteLength: 16 });
          const a = new Uint8Array(b);
          a[10] = 5;
          b.resize(4);
          const x = a[10];
          return x === x ? x : -1; // NaN !== NaN → -1
        }`),
      ).toBe(-1);
    });
  });

  describe("non-resizable views stay fixed (byte-inert guarantee)", () => {
    it("a view over a plain ArrayBuffer keeps a fixed .length", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(4);
          const a = new Uint8Array(b);
          return a.length;
        }`),
      ).toBe(4);
    });

    it("sibling views over a plain buffer still observe each other's writes (B1 preserved)", async () => {
      expect(
        await runStandalone(`export function f(): number {
          const b = new ArrayBuffer(8);
          const a = new Uint8Array(b);
          const c = new Uint8Array(b);
          a[0] = 99;
          return c[0];
        }`),
      ).toBe(99);
    });
  });
});
