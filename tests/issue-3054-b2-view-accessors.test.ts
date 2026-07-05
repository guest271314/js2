// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3054 B2 — TypedArray view accessor props + the windowing constructor, on B1's
// shared-backing `$__ta_view {length, buf, byteOffset}` representation.
//
// B1 shipped `new <TA>(buffer)` as a shared-backing view (offset-0, byteOffset
// pinned 0) with element read/write. B2 adds:
//   (a) the accessor props on a view receiver — `.byteLength`, `.byteOffset`,
//       `.buffer` (object IDENTITY — returns the same ArrayBuffer vec ref),
//       `BYTES_PER_ELEMENT`, and verifies `.length` (B1);
//   (b) the windowing ctor `new <TA>(buffer, byteOffset[, length])` — POPULATES
//       the byteOffset field so the window offsets into the buffer, with the
//       spec RangeError validation (§23.2.5.1).
//
// VALIDATION NOTE (#3055/#3056): the standalone lane does NOT enforce in-Wasm
// numeric `assert.sameValue`, so B2 correctness is invisible to the standalone
// test262 floor. These assertions are HOST-ENFORCED — each program RETURNS a
// number to JS and vitest `expect(...).toBe(...)` enforces it. Standalone/WASI
// lane only (host-mode ArrayBuffer is a host object, not a native vec — see B1).

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

/** True iff the compiled standalone program throws (a Wasm exception) when run. */
async function throwsStandalone(src: string): Promise<boolean> {
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

describe("#3054 B2 view accessor props", () => {
  it(".byteLength = element count × element size (Int32Array → 8)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf);
          return a.byteLength;
        }
      `),
    ).toBe(8);
  });

  it(".byteLength for Float64Array over a 24-byte buffer → 24", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(24);
          const a = new Float64Array(buf);
          return a.byteLength;
        }
      `),
    ).toBe(24);
  });

  it(".byteOffset is 0 for an offset-0 (B1) view", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf);
          return a.byteOffset;
        }
      `),
    ).toBe(0);
  });

  it(".BYTES_PER_ELEMENT is the per-view element size (Int32Array → 4)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf);
          return a.BYTES_PER_ELEMENT;
        }
      `),
    ).toBe(4);
  });

  it(".BYTES_PER_ELEMENT for Float64Array → 8", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const a = new Float64Array(buf);
          return a.BYTES_PER_ELEMENT;
        }
      `),
    ).toBe(8);
  });

  it(".length is the element count (B1) — 8-byte buffer / 4 = 2", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf);
          return a.length;
        }
      `),
    ).toBe(2);
  });

  it(".buffer is object-identical across sibling views (a.buffer === b.buffer)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint8Array(buf);
          const b = new Uint8Array(buf);
          return (a.buffer === b.buffer) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it(".buffer is object-identical to the source ArrayBuffer (a.buffer === buf)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint8Array(buf);
          return (a.buffer === buf) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it(".buffer.byteLength reads the underlying buffer byte length", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint8Array(buf);
          return a.buffer.byteLength;
        }
      `),
    ).toBe(8);
  });
});

describe("#3054 B2 windowing constructor new <TA>(buffer, byteOffset, length)", () => {
  it("windowed write lands at the correct absolute buffer bytes (window→full-view)", async () => {
    // Int32Array window at byte offset 4 covering 2 elements; a[0] maps to byte 4,
    // which a full-buffer Int32Array sees at index 1.
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const a = new Int32Array(buf, 4, 2);
          a[0] = 9;
          const b = new Int32Array(buf);
          return b[1];
        }
      `),
    ).toBe(9);
  });

  it("full-view write is observed through the window (full-view→window)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const b = new Int32Array(buf);
          b[1] = 77;
          const a = new Int32Array(buf, 4, 2);
          return a[0];
        }
      `),
    ).toBe(77);
  });

  it("windowed view reports its byteOffset", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const a = new Int32Array(buf, 4, 2);
          return a.byteOffset;
        }
      `),
    ).toBe(4);
  });

  it("windowed view reports its element length and byteLength", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const a = new Int32Array(buf, 4, 2);
          return a.length * 100 + a.byteLength;
        }
      `),
    ).toBe(208); // length 2, byteLength 8
  });

  it("auto-length (2-arg) window fills the remainder of the buffer", async () => {
    // 16-byte buffer, Int32Array at offset 4 → (16-4)/4 = 3 elements.
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const a = new Int32Array(buf, 4);
          return a.length;
        }
      `),
    ).toBe(3);
  });

  it("Uint8Array window (element size 1) writes through to the buffer", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint8Array(buf, 3, 2);
          a[0] = 42;
          const b = new Uint8Array(buf);
          return b[3];
        }
      `),
    ).toBe(42);
  });

  it("windowed Float64Array reads/writes 8-byte elements at the offset", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(24);
          const a = new Float64Array(buf, 8, 2);
          a[0] = 1.5;
          a[1] = 1.5;
          return a[0] + a[1];
        }
      `),
    ).toBe(3);
  });

  it("a sibling window observes a DataView write into its byte range", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const dv = new DataView(buf);
          dv.setUint8(4, 55);
          const a = new Uint8Array(buf, 4, 4);
          return a[0];
        }
      `),
    ).toBe(55);
  });

  it("throws RangeError when byteOffset is not a multiple of the element size", async () => {
    // Int32Array requires a 4-aligned offset; 2 is misaligned (§23.2.5.1 step 11).
    expect(
      await throwsStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const a = new Int32Array(buf, 2, 2);
          return a[0];
        }
      `),
    ).toBe(true);
  });

  it("throws RangeError when byteOffset + length exceeds the buffer", async () => {
    expect(
      await throwsStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf, 0, 10);
          return a[0];
        }
      `),
    ).toBe(true);
  });

  it("throws RangeError when the 2-arg byteOffset is outside the buffer", async () => {
    expect(
      await throwsStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf, 16);
          return a.length;
        }
      `),
    ).toBe(true);
  });
});

describe("#3054 B2 DataView windowing (pre-B1 $__dv_window — regression guard)", () => {
  it("windowed DataView reports byteOffset / byteLength", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const dv = new DataView(buf, 4, 8);
          return dv.byteOffset * 100 + dv.byteLength;
        }
      `),
    ).toBe(408); // byteOffset 4, byteLength 8
  });

  it("windowed DataView get/set is offset into the buffer (observed by a TA over the same buffer)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(16);
          const dv = new DataView(buf, 4, 8);
          dv.setUint8(0, 88);
          const a = new Uint8Array(buf);
          return a[4];
        }
      `),
    ).toBe(88);
  });
});
