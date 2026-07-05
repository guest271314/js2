// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3054 B3 — proto-method WRITE-THROUGH on TypedArray view receivers.
//
// B1 gave `new <TA>(arrayBuffer)` a shared-backing `$__ta_view` (element
// read/write alias the buffer). B1's Option-A de-view materializes the view into
// a fresh native vec for prototype-method dispatch (so `.fill`/`.sort`/… don't
// `ref.cast`-trap on the view), but that copy was DE-ALIASED: a mutating
// method's writes landed in the copy and were LOST — never reached the buffer,
// so sibling views / DataViews over the same buffer didn't observe them.
//
// B3 makes the de-viewed path WRITE-THROUGH: after a mutating method
// (`.fill`/`.set`/`.sort`/`.copyWithin`/`.reverse`) runs on the copy, the copy
// is byte-encoded back into the view's buffer at `byteOffset`, restoring
// shared-backing semantics. Read-only methods (`.includes`/`.indexOf`/…) do NOT
// write back (nothing to propagate). Standalone/WASI lane (native i32_byte vec).
//
// Validation is HOST-enforced: standalone does not enforce numeric asserts
// (#3055/#3056), so we run the compiled `f()` on the JS host and assert its
// numeric return directly.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#3054 B3 TypedArray proto-method write-through", () => {
  it(".fill writes through to a sibling view", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint8Array(buf);
          const b = new Uint8Array(buf);
          a.fill(9);
          return b[0] + b[7]; // 9 + 9
        }
      `),
    ).toBe(18);
  });

  it(".set writes reach the buffer (observed by a sibling)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8Array(buf);
          const b = new Uint8Array(buf);
          a.set([10, 20, 30, 40]);
          return b[2];
        }
      `),
    ).toBe(30);
  });

  it(".set with an offset writes the right window of the buffer", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8Array(buf);
          const b = new Uint8Array(buf);
          a.set([7, 8], 2);
          return b[2] * 10 + b[3];
        }
      `),
    ).toBe(78);
  });

  // NOTE — `.sort()` / `.reverse()` write-through is NOT asserted here because
  // the NATIVE packed-typed-array `.sort`/`.reverse` implementations are
  // independently broken for the de-view target vec (verified on this same base
  // with NO views / NO B3 code): native `new Uint8Array(4).sort()` is a no-op
  // and native `.reverse()` leaks a packed `i8` into a value position at binary
  // emit. B3's write-back sits DOWNSTREAM of the method — it faithfully
  // propagates whatever the method produced — so it cannot be validated through a
  // broken native method. Those native packed-TA method fixes are a separate,
  // pre-existing gap (flagged in the PR); B3 is complete for the methods whose
  // native packed lowering already works (`.fill` / `.set` / `.copyWithin`).

  it(".copyWithin writes through to the buffer", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8Array(buf);
          a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4;
          const b = new Uint8Array(buf);
          a.copyWithin(0, 2); // [3,4,3,4]
          return b[0] * 10 + b[1];
        }
      `),
    ).toBe(34);
  });

  it("read-only .includes does NOT clobber the buffer", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8Array(buf);
          a[0] = 5; a[1] = 6;
          const b = new Uint8Array(buf);
          const has = a.includes(6);
          // buffer must be untouched: b[0]=5, b[1]=6; has must be true
          return b[0] * 10 + b[1] + (has ? 0 : 100);
        }
      `),
    ).toBe(56);
  });

  it("read-only .indexOf does NOT clobber the buffer", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8Array(buf);
          a[0] = 8; a[1] = 9;
          const b = new Uint8Array(buf);
          const idx = a.indexOf(9);
          return b[0] * 10 + b[1] + idx; // 89 + 1
        }
      `),
    ).toBe(90);
  });

  it("Int32Array .fill writes correct little-endian bytes (cross-width)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const w = new Int32Array(buf);
          const by = new Uint8Array(buf);
          w.fill(513); // 0x0201 → LE bytes [1, 2, 0, 0]
          return by[0] * 100 + by[1];
        }
      `),
    ).toBe(102);
  });

  it("Int16Array .fill of a negative value writes correct LE bytes", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const w = new Int16Array(buf);
          const by = new Uint8Array(buf);
          w.fill(-1); // both int16 slots = 0xFFFF → all bytes 255
          return by[0] + by[1] + by[2] + by[3];
        }
      `),
    ).toBe(1020);
  });

  it("Float32Array .fill round-trips through the buffer to a sibling", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Float32Array(buf);
          const b = new Float32Array(buf);
          a.fill(1.5);
          return b[0] + b[1]; // 3.0
        }
      `),
    ).toBe(3);
  });

  it("Uint32Array .fill write-through reads back unsigned (i32_elem)", async () => {
    // Exercises the NON-packed i32_elem read path (`array.get` + convert_i32_u).
    // Values > 2^31 saturate in the PRE-EXISTING native fill path (a separate
    // gap, verified without B3), so use a value in range to validate the
    // write-through round trip itself.
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Uint32Array(buf);
          const b = new Uint32Array(buf);
          a.fill(70000);
          return b[1];
        }
      `),
    ).toBe(70000);
  });

  it("Int32Array .fill of a negative value writes through (signed i32_elem)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const a = new Int32Array(buf);
          const b = new Int32Array(buf);
          a.fill(-5);
          return b[0];
        }
      `),
    ).toBe(-5);
  });

  it("window-offset .fill writes the right absolute bytes", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(8);
          const full = new Uint8Array(buf);
          const win = new Uint8Array(buf, 4); // window at byteOffset 4
          win.fill(7);
          // bytes 0..3 untouched (0), bytes 4..7 = 7
          return full[3] * 100 + full[4] + full[7]; // 0 + 7 + 7
        }
      `),
    ).toBe(14);
  });

  it("write-through then a subsequent element read reflects the mutation", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const buf = new ArrayBuffer(4);
          const a = new Uint8Array(buf);
          a.fill(5);
          // read back through the SAME view (element read hits the buffer)
          return a[0] + a[3]; // 10
        }
      `),
    ).toBe(10);
  });
});
