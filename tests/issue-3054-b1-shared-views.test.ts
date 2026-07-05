// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3054 B1 — shared-backing TypedArray / DataView views over an ArrayBuffer.
//
// Before B1, `new <TA>(arrayBuffer)` COPIED the buffer's bytes into a fresh
// backing array (standalone) / treated the buffer as a length (host), so
// sibling views and DataViews over the same buffer did NOT observe each other's
// writes. B1 replaces the copy with a `$__ta_view` struct that REFS the buffer's
// vec and byte-decodes each element little-endian — true aliasing. This is a
// standalone/WASI-lane change (the native i32_byte vec representation of
// ArrayBuffer only exists host-free); host mode routes buffers through the
// runtime and is out of scope here.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#3054 B1 shared-backing TypedArray/DataView views", () => {
  it("sibling Uint8Array views observe each other's writes (the verified bug)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint8Array(buf);
          const b = new Uint8Array(buf);
          a[0] = 99;
          return b[0];
        }
      `),
    ).toBe(99);
  });

  it("a DataView over the same buffer sees a TypedArray write", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint8Array(buf);
          a[0] = 7;
          const dv = new DataView(buf);
          return dv.getUint8(0);
        }
      `),
    ).toBe(7);
  });

  it("a TypedArray over the same buffer sees a DataView write", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const dv = new DataView(buf);
          dv.setUint8(0, 55);
          const a = new Uint8Array(buf);
          return a[0];
        }
      `),
    ).toBe(55);
  });

  it("sibling Int32Array views alias (4-byte little-endian element)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf);
          const b = new Int32Array(buf);
          a[1] = 12345;
          return b[1];
        }
      `),
    ).toBe(12345);
  });

  it("a Uint8Array write is visible through an Int32Array view (byte layout)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const bytes = new Uint8Array(buf);
          const words = new Int32Array(buf);
          words[0] = 0;
          bytes[0] = 1;
          bytes[1] = 2;
          return words[0]; // LE: 1 + 2*256
        }
      `),
    ).toBe(513);
  });

  it("Int16Array over a buffer sign-extends on read", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Int16Array(buf);
          a[0] = -1000;
          return a[0];
        }
      `),
    ).toBe(-1000);
  });

  it("Int8Array over a buffer wraps + sign-extends (200 -> -56)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Int8Array(buf);
          a[0] = 200;
          return a[0];
        }
      `),
    ).toBe(-56);
  });

  it("Uint8Array element write is modular (257 -> 1)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8Array(buf);
          a[0] = 257;
          return a[0];
        }
      `),
    ).toBe(1);
  });

  it("Uint32Array over a buffer round-trips a value above 2^31", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint32Array(buf);
          a[0] = 4000000000;
          return a[0];
        }
      `),
    ).toBe(4000000000);
  });

  it("Float64Array over a buffer round-trips a fractional value", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Float64Array(buf);
          a[0] = 3.5;
          return a[0];
        }
      `),
    ).toBe(3.5);
  });

  it("Float32Array over a buffer stores two elements at width 4", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Float32Array(buf);
          a[0] = 1.5;
          a[1] = 2.5;
          return a[0] + a[1];
        }
      `),
    ).toBe(4);
  });

  it("Uint8ClampedArray clamps out-of-range writes ([0,255])", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8ClampedArray(buf);
          a[0] = 300;
          a[1] = -5;
          return a[0] * 1000 + a[1]; // 255000 + 0
        }
      `),
    ).toBe(255000);
  });

  it("Uint8ClampedArray rounds ties to even (2.5 -> 2, 127.6 -> 128)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8ClampedArray(buf);
          a[0] = 2.5;
          a[1] = 127.6;
          return a[0] * 1000 + a[1]; // 2000 + 128
        }
      `),
    ).toBe(2128);
  });

  it("view .length is the element count, not the byte length", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf);
          return a.length; // 8 bytes / 4 = 2
        }
      `),
    ).toBe(2);
  });

  it("iterates a buffer-backed view with a .length loop (write then sum)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8Array(buf);
          for (let i = 0; i < a.length; i++) { a[i] = i * 10; }
          let s = 0;
          for (let i = 0; i < a.length; i++) { s = s + a[i]; }
          return s; // 0 + 10 + 20 + 30
        }
      `),
    ).toBe(60);
  });
});
