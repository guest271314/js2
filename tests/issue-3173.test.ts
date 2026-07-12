// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3173 — standalone DataView.prototype get*/set* spec semantics:
// brand check ([[DataView]] internal slot), ToIndex coercion order, detached-
// buffer TypeError ordering, bounds RangeError, littleEndian ToBoolean, the
// Float16 codec, and the BigInt64/BigUint64 i64 codec.
//
// Each case compiles a self-contained module with `--target standalone`
// (zero imports — the standalone floor) and asserts the exported probe value.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, JSON.stringify(r.errors?.slice(0, 2))).toBe(true);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
  expect(imports, "standalone module must not leak host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  (instance.exports as { _start?: () => void })._start?.();
  return (instance.exports as { test(): unknown }).test();
}

describe("#3173 standalone DataView get*/set* spec semantics", () => {
  it("ToIndex: NaN/-0/fractional offsets read index 0; negative/Infinity/2^53 throw RangeError", async () => {
    const result = await runStandalone(`
      const buffer = new ArrayBuffer(12);
      const dv = new DataView(buffer, 0);
      dv.setUint8(0, 39);
      let ok = 0;
      if (dv.getUint8(NaN as any) === 39) ok += 1;
      if (dv.getUint8(-0) === 39) ok += 2;
      if (dv.getUint8(0.9 as any) === 39) ok += 4;
      try { dv.getUint8(-1); } catch (e) { ok += 8; }
      try { dv.getUint8(Infinity); } catch (e) { ok += 16; }
      try { dv.getUint8(9007199254740992 as any); } catch (e) { ok += 32; }
      export function test(): number { return ok; }
    `);
    expect(result).toBe(63);
  });

  it("bounds: getIndex + elementSize > viewByteLength throws RangeError (windowed views included)", async () => {
    const result = await runStandalone(`
      const buffer = new ArrayBuffer(12);
      let ok = 0;
      const dv = new DataView(buffer, 0);
      try { dv.getUint8(12); } catch (e) { ok += 1; }
      try { dv.getFloat64(5); } catch (e) { ok += 2; }
      const win = new DataView(buffer, 4, 2);
      try { win.getUint16(1); } catch (e) { ok += 4; }
      if (win.getUint16(0) === 0) ok += 8;
      export function test(): number { return ok; }
    `);
    expect(result).toBe(15);
  });

  it("brand: DataView.prototype method .call on a non-DataView receiver throws TypeError", async () => {
    const result = await runStandalone(`
      const getUint8 = DataView.prototype.getUint8;
      const setUint32 = DataView.prototype.setUint32;
      let ok = 0;
      try { getUint8.call({}); } catch (e) { ok += 1; }
      try { getUint8.call(undefined); } catch (e) { ok += 2; }
      try { getUint8.call(new ArrayBuffer(4)); } catch (e) { ok += 4; }
      try { setUint32.call([], 0, 1); } catch (e) { ok += 8; }
      const dv = new DataView(new ArrayBuffer(4));
      dv.setUint8(0, 7);
      if (getUint8.call(dv, 0) === 7) ok += 16;
      export function test(): number { return ok; }
    `);
    expect(result).toBe(31);
  });

  it("detached buffer: $DETACHBUFFER-style marker flips accessors and byteLength to TypeError", async () => {
    const result = await runStandalone(`
      function detach(buf: any): void { (buf as any).__detached__ = true; }
      const buffer = new ArrayBuffer(12);
      const dv = new DataView(buffer, 0);
      dv.setUint8(0, 1);
      detach(buffer);
      let ok = 0;
      try { dv.getUint8(0); ok = -100; } catch (e) { ok += 1; }
      try { dv.setUint8(0, 1); ok = -100; } catch (e) { ok += 2; }
      // detached beats out-of-range: TypeError fires before the bounds RangeError
      try { dv.getFloat64(13); ok = -100; } catch (e) { ok += 4; }
      try { const n = dv.byteLength; ok = -100; } catch (e) { ok += 8; }
      export function test(): number { return ok; }
    `);
    expect(result).toBe(15);
  });

  it("littleEndian ToBoolean: objects are truthy, NaN/0/undefined are falsy", async () => {
    const result = await runStandalone(`
      const buffer = new ArrayBuffer(8);
      const dv = new DataView(buffer, 0);
      let ok = 0;
      dv.setUint16(0, 6, {} as any);          // truthy → LE write: 06 00
      if (dv.getUint8(0) === 6 && dv.getUint8(1) === 0) ok += 1;
      dv.setUint16(0, 6, NaN as any);         // falsy → BE write: 00 06
      if (dv.getUint8(0) === 0 && dv.getUint8(1) === 6) ok += 2;
      dv.setUint16(0, 6);                     // absent → BE
      if (dv.getUint8(1) === 6) ok += 4;
      if (dv.getUint16(0, "x" as any) === 1536) ok += 8; // truthy string → LE read of 00 06
      export function test(): number { return ok; }
    `);
    expect(result).toBe(15);
  });

  it("setter ordering: index RangeError before value coercion; poison after index check", async () => {
    const result = await runStandalone(`
      const buffer = new ArrayBuffer(8);
      const dv = new DataView(buffer, 0);
      let ok = 0;
      const poison = { valueOf: function(): number { throw new Error("poison"); } };
      // index check fires BEFORE ToNumber(value)
      try { dv.setUint8(-1, poison as any); } catch (e) {
        if (String(e).indexOf("poison") === -1) ok += 1;
      }
      // in-range: the poison value coercion throws (before the bounds check would pass anyway)
      try { dv.setUint8(0, poison as any); } catch (e) {
        if (String(e).indexOf("poison") !== -1) ok += 2;
      }
      // setter used as an expression returns undefined
      const r = dv.setUint8(0, 1);
      if (r === undefined) ok += 4;
      export function test(): number { return ok; }
    `);
    expect(result).toBe(7);
  });

  it("Float16 codec: roundtrip, endianness, Infinity, NaN, subnormals, overflow-to-Infinity", async () => {
    const result = await runStandalone(`
      const buffer = new ArrayBuffer(8);
      const dv = new DataView(buffer, 0);
      let ok = 0;
      dv.setFloat16(0, 3.078125, false);
      if (dv.getFloat16(0, false) === 3.078125) ok += 1;
      if (dv.getUint8(0) === 0x42 && dv.getUint8(1) === 0x28) ok += 2; // BE bit pattern
      dv.setUint8(0, 124); dv.setUint8(1, 0);      // 0x7C00 = +Infinity
      if (dv.getFloat16(0) === Infinity) ok += 4;
      dv.setUint8(0, 252);                          // 0xFC00 = -Infinity
      if (dv.getFloat16(0) === -Infinity) ok += 8;
      dv.setFloat16(0, NaN, false);
      const n = dv.getFloat16(0, false);
      if (n !== n) ok += 16;
      dv.setFloat16(0, 65536, false);               // overflow → Infinity
      if (dv.getFloat16(0, false) === Infinity) ok += 32;
      dv.setFloat16(0, 5.960464477539063e-8, false); // smallest subnormal
      if (dv.getFloat16(0, false) === 5.960464477539063e-8) ok += 64;
      export function test(): number { return ok; }
    `);
    expect(result).toBe(127);
  });

  it("BigInt64/BigUint64: exact i64 roundtrip, byte order, and === against BigInt literals", async () => {
    const result = await runStandalone(`
      function assertSame(actual: any, expected: any): number { return actual === expected ? 1 : 0; }
      const buffer = new ArrayBuffer(8);
      const dv = new DataView(buffer, 0);
      let ok = 0;
      dv.setBigInt64(0, -2n, false);
      if (dv.getBigInt64(0, false) === -2n) ok += 1;
      if (dv.getUint8(0) === 0xff && dv.getUint8(7) === 0xfe) ok += 2; // BE two's complement
      dv.setBigInt64(0, -0x6f80ff08n, true);
      // exact 60-bit read-back through the i64 carrier (beyond f64 precision)
      if (dv.getBigInt64(0, false) === -0x7ff806f00000001n) ok += 4;
      // any-boxed comparison agrees with the literal's boxing (unary-minus keeps the brand)
      if (assertSame(dv.getBigInt64(0, true), -0x6f80ff08n) === 1) ok += 8;
      // ToBigUint64 is modular: -1n stores as 2^64-1 (all bytes 0xff)
      dv.setBigUint64(0, -1n as any, false);
      if (dv.getUint8(0) === 0xff && dv.getUint8(7) === 0xff) ok += 16;
      export function test(): number { return ok; }
    `);
    expect(result).toBe(31);
  });

  it("BigInt setters: ToBigInt(undefined) throws TypeError (missing value arg, both dispatch paths)", async () => {
    // Separate module: the `(dv as any)` dispatcher registration changes which
    // `===` lowering later code gets (the helper route lacks a bigint-box arm —
    // a pre-existing #1644 rep gap), so the value-compare arms live above.
    const result = await runStandalone(`
      const buffer = new ArrayBuffer(8);
      const dv = new DataView(buffer, 0);
      let ok = 0;
      try { (dv as any).setBigInt64(0); ok = -100; } catch (e) { ok += 1; } // dispatcher path
      try { dv.setBigInt64(0 as any); ok = -100; } catch (e) { ok += 2; }  // direct path
      export function test(): number { return ok; }
    `);
    expect(result).toBe(3);
  });

  it("any-receiver dispatch: accessors inside closures (widened receiver) keep full spec semantics", async () => {
    const result = await runStandalone(`
      var sample: any;
      const buffer = new ArrayBuffer(12);
      sample = new DataView(buffer, 0);
      let ok = 0;
      // the test262 assert.throws shape: the accessor runs inside a closure
      // where the receiver has widened to \`any\` (the closed-method dispatcher's
      // $__dv_window brand arm).
      const read13 = function(): number { return sample.getUint8(13); };
      const readNeg = function(): number { return sample.getUint8(-1); };
      const write11 = function(): void { sample.setUint16(11, 1); };
      try { read13(); } catch (e) { ok += 1; }
      try { readNeg(); } catch (e) { ok += 2; }
      sample.setUint8(3, 7);
      if (sample.getUint8(3) === 7) ok += 4;
      try { write11(); } catch (e) { ok += 8; }
      export function test(): number { return ok; }
    `);
    expect(result).toBe(15);
  });

  it("buffer/byteLength/byteOffset: identity buffer, window fields, ArrayBuffer receiver still works", async () => {
    const result = await runStandalone(`
      const buffer = new ArrayBuffer(12);
      const dv = new DataView(buffer, 4, 6);
      let ok = 0;
      if (dv.byteOffset === 4) ok += 1;
      if (dv.byteLength === 6) ok += 2;
      if (dv.buffer === buffer) ok += 4;          // §25.3.4.1 identity
      if (buffer.byteLength === 12) ok += 8;      // plain ArrayBuffer read unaffected
      const dv0 = new DataView(buffer);           // 1-arg ctor is now window-wrapped
      if (dv0.byteOffset === 0 && dv0.byteLength === 12) ok += 16;
      // shared backing: writes through one view are visible through the other
      dv0.setUint8(4, 42);
      if (dv.getUint8(0) === 42) ok += 32;
      export function test(): number { return ok; }
    `);
    expect(result).toBe(63);
  });

  it("host lane unaffected: the same DataView program still compiles and runs against the JS host", async () => {
    const src = `
      const buffer = new ArrayBuffer(8);
      const dv = new DataView(buffer, 0);
      dv.setUint16(0, 6, true);
      export function test(): number { return dv.getUint16(0, true); }
    `;
    const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
  });
});
