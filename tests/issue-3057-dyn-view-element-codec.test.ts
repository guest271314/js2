// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3057 — runtime-kind byte codec for a boxed `$__ta_dyn_view` element get/set.
//
// #3054 D+E landed dynamic `new <ctorVar>(rab)` producing a runtime-kinded
// `$__ta_dyn_view {length, buf, byteOffset, kind}`, but BANKED element access:
// `ta[i]` / `ta[i]=v` on such a view (reached through an `any` receiver) went
// through the generic dynamic index path, which has no arm switching on the
// runtime `kind` byte — reads returned 0, writes silently no-op'd. This wires a
// `ref.test $__ta_dyn_view`-gated runtime-kind byte codec into that path, reusing
// dataview-native's little-endian engine. Host-enforced (the standalone floor
// doesn't enforce in-Wasm numeric asserts, #3055/#3056), so each program returns
// a number to JS and vitest `expect` enforces it.

async function run(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#3057 dynamic $__ta_dyn_view element codec", () => {
  it("Int32 dynamic view get/set round-trips the written value", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Int32Array];
          const buf = new ArrayBuffer(16);
          let r = 0;
          for (const c of ctors) { const a = new c(buf); a[0] = 42; a[1] = 7; r = a[0] + a[1]; }
          return r; // 49
        }`),
    ).toBe(49);
  });

  it("Float64 dynamic view get/set round-trips a fractional value", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Float64Array];
          const buf = new ArrayBuffer(32);
          let r = 0;
          for (const c of ctors) { const a = new c(buf); a[2] = 3.5; r = a[2]; }
          return r; // 3.5
        }`),
    ).toBe(3.5);
  });

  it("Int8 write truncates to signed 8-bit (200 → -56)", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Int8Array];
          const buf = new ArrayBuffer(8);
          let r = 0;
          for (const c of ctors) { const a = new c(buf); a[0] = 200; r = a[0]; }
          return r; // ToInt8(200) = -56
        }`),
    ).toBe(-56);
  });

  it("Uint8Clamped write clamps out-of-range values to [0,255]", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Uint8ClampedArray];
          const buf = new ArrayBuffer(8);
          let r = 0;
          for (const c of ctors) { const a = new c(buf); a[0] = 300; a[1] = -7; r = a[0] * 1000 + (a[1] + 1); }
          return r; // clamp(300)=255, clamp(-7)=0 → 255000 + 1
        }`),
    ).toBe(255001);
  });

  it("Uint32 write preserves a value above 2^31 (modular, unsigned)", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Uint32Array];
          const buf = new ArrayBuffer(8);
          let r = 0;
          for (const c of ctors) { const a = new c(buf); a[0] = 4000000000; r = a[0]; }
          return r; // 4_000_000_000 (unsigned, not clamped to 2^31-1)
        }`),
    ).toBe(4000000000);
  });

  it("a sibling static view observes a dynamic-view write (true aliasing)", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Uint8Array];
          const buf = new ArrayBuffer(8);
          for (const c of ctors) { const a = new c(buf); a[3] = 99; }
          const s = new Uint8Array(buf);
          return s[3]; // 99 — write reached the shared backing buffer
        }`),
    ).toBe(99);
  });

  it("a windowed dynamic view (byteOffset != 0) reads/writes absolute buffer bytes", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Int32Array];
          const buf = new ArrayBuffer(32);
          let r = 0;
          for (const c of ctors) { const a = new c(buf, 8, 3); a[0] = 55; r = a[0]; const full = new Int32Array(buf); r = r + full[2]; }
          return r; // a[0] aliases full[2] (byteOffset 8 = element 2) → 55 + 55
        }`),
    ).toBe(110);
  });

  it("an out-of-bounds dynamic-view write is a silent no-op; in-bounds preserved", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Int32Array];
          const buf = new ArrayBuffer(8); // 2 Int32 elements
          let r = 0;
          for (const c of ctors) { const a = new c(buf); a[0] = 11; a[5] = 999; r = a[0]; }
          return r; // a[5] OOB no-op, a[0] unchanged → 11
        }`),
    ).toBe(11);
  });

  it("cross-function element read on a dyn view works (helper compiled before construct)", async () => {
    // ToNumbers-shape: the read `x[i]` is in a helper defined BEFORE the construct,
    // so the `$__ta_dyn_view` type isn't registered when the helper compiles — the
    // module pre-scan (#3057) must enable the codec arm anyway.
    expect(
      await run(`
        function readAt(x: any, i: number): number { return x[i]; }
        export function f(): number {
          const ctors: any[] = [Int32Array];
          const buf = new ArrayBuffer(16);
          let s = 0;
          for (const c of ctors) { const a = new c(buf); a[2] = 77; s = s + readAt(a, 2); }
          return s; // 77
        }`),
    ).toBe(77);
  });

  it("cross-function element write on a dyn view works (helper compiled before construct)", async () => {
    expect(
      await run(`
        function writeAt(x: any, i: number, v: number): void { x[i] = v; }
        export function f(): number {
          const ctors: any[] = [Uint16Array];
          const buf = new ArrayBuffer(16);
          let s = 0;
          for (const c of ctors) { const a = new c(buf); writeAt(a, 3, 4242); s = s + a[3]; }
          return s; // 4242
        }`),
    ).toBe(4242);
  });

  it("HAZARD GUARD: a plain-array `any[i]` in the SAME module as a dyn view is unaffected", async () => {
    // A boxed plain-array `any` receiver shares the generic index path with the
    // dyn-view codec. The `ref.test $__ta_dyn_view` gate must fall through to the
    // plain-array path (read via __extern_get_idx). Reads must stay correct.
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Int32Array];
          const buf = new ArrayBuffer(16);
          let s = 0;
          for (const c of ctors) { const a = new c(buf); a[1] = 500; s = s + a[1]; } // dyn view → 500
          const plain: any = [10, 20, 30];
          s = s + plain[0] + plain[2]; // plain array reads UNAFFECTED → +40
          return s; // 540
        }`),
    ).toBe(540);
  });

  it("mixed cross-function dispatch: same `any` param indexes both a dyn view and a plain array", async () => {
    expect(
      await run(`
        function readAt(x: any, i: number): number { return x[i]; }
        export function f(): number {
          const ctors: any[] = [Int32Array];
          const buf = new ArrayBuffer(16);
          let s = 0;
          for (const c of ctors) { const a = new c(buf); a[2] = 77; s = s + readAt(a, 2); } // dyn view → 77
          const plain: any = [5, 6, 7];
          s = s + readAt(plain, 1); // plain array → 6
          return s; // 83
        }`),
    ).toBe(83);
  });

  it("windowed fixed-length view goes fully OOB when the buffer shrinks below the window, then back on regrow", async () => {
    // §10.4.5.11 IsTypedArrayOutOfBounds: a NON-length-tracking view over a
    // resizable buffer is all-or-nothing — shrinking the buffer below
    // `byteOffset + length*elemSize` makes EVERY index read `undefined`; regrowing
    // restores the (byte-preserved) elements. The stored-length reader (used by
    // `.byteLength`) got this wrong (stale in-bounds value after a shrink) — this
    // was the #3057 de-vacuification regression on out-of-bounds-get-and-set.js.
    expect(
      await run(`
        function mk(bl: number, mx: number): ArrayBuffer { return new ArrayBuffer(bl, { maxByteLength: mx }); }
        export function f(): number {
          const ctors: any[] = [Int32Array];
          let code = 0;
          for (const c of ctors) {
            const rab = mk(16, 160);        // 4 Int32
            const a = new c(rab, 0, 4);
            a[0] = 7;
            const before = a[0];            // in-bounds → 7
            rab.resize(8);                  // window needs 16 bytes → view OOB
            const oob = a[0] === undefined ? 1 : 0; // → 1
            rab.resize(16);                 // regrow → in-bounds again
            const after = a[0];             // 7 (bytes preserved)
            code = before * 100 + oob * 10 + after;
          }
          return code; // 717
        }`),
    ).toBe(717);
  });

  it("length-tracking view shrinks its in-bounds range on resize (a[large] → undefined)", async () => {
    expect(
      await run(`
        function mk(bl: number, mx: number): ArrayBuffer { return new ArrayBuffer(bl, { maxByteLength: mx }); }
        export function f(): number {
          const ctors: any[] = [Int32Array];
          let code = 0;
          for (const c of ctors) {
            const rab = mk(16, 160);        // 4 Int32, auto-length
            const a = new c(rab);
            a[3] = 9;
            const before = a[3];            // 9
            rab.resize(8);                  // now 2 Int32 → a[3] OOB
            const oob = a[3] === undefined ? 1 : 0; // → 1
            code = before * 10 + oob;
          }
          return code; // 91
        }`),
    ).toBe(91);
  });

  it("Uint16 little-endian write is observed byte-exact by a Uint8 sibling view", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Uint16Array];
          const buf = new ArrayBuffer(8);
          for (const c of ctors) { const a = new c(buf); a[0] = 0x1234; }
          const b = new Uint8Array(buf);
          return b[0] * 1000 + b[1]; // little-endian: b[0]=0x34=52, b[1]=0x12=18 → 52018
        }`),
    ).toBe(52018);
  });
});
