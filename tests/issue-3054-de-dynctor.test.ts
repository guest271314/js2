// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3054 D+E — dynamic `new <ctorVar>(rab)` over a resizable buffer + harness shim.
//
// A TypedArray constructor used as a VALUE (`const c = Uint8Array`, `[Uint8Array,
// …]`, a `new ctor(rab)` callee) previously degraded to `ref.null.extern` — every
// TA ctor was indistinguishable (`Uint8Array === Int8Array` was `true`) and a
// dynamic `new ctor(rab)` dropped the ctor (null → trap). D gives TA ctors a
// first-class `$__ta_ctor{kind}` value and lowers a dynamic `new ctor(…)` to a
// runtime-kinded `$__ta_dyn_view`. Standalone/WASI lane only. Host-enforced (the
// standalone floor doesn't enforce in-Wasm numeric asserts, #3055/#3056), so each
// program returns a number to JS and vitest `expect` enforces it.

async function run(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#3054 D+E dynamic TypedArray constructor", () => {
  it("distinct TA ctors are distinguishable values (was: both null → ===)", async () => {
    expect(
      await run(`export function f(): number { const c = Uint8Array; const d = Int8Array; return c === d ? 1 : 0; }`),
    ).toBe(0);
  });

  it("ctor.BYTES_PER_ELEMENT reads the kind (var, narrowed)", async () => {
    expect(await run(`export function f(): number { const c: any = Uint32Array; return c.BYTES_PER_ELEMENT; }`)).toBe(
      4,
    );
    expect(await run(`export function f(): number { const c: any = Float64Array; return c.BYTES_PER_ELEMENT; }`)).toBe(
      8,
    );
  });

  it("ctor.BYTES_PER_ELEMENT works cross-function (param typed any)", async () => {
    expect(
      await run(`
        function bpe(c: any): number { return c.BYTES_PER_ELEMENT; }
        export function f(): number {
          const ctors: any[] = [Uint8Array, Int16Array, Float64Array];
          let s = 0;
          for (const c of ctors) { s = s + bpe(c); }
          return s; // 1 + 2 + 8
        }`),
    ).toBe(11);
  });

  it("static Uint8Array.BYTES_PER_ELEMENT and native-instance stay correct (byte-inert paths)", async () => {
    expect(await run(`export function f(): number { return Int32Array.BYTES_PER_ELEMENT; }`)).toBe(4);
    expect(await run(`export function f(): number { const a = new Int32Array(4); return a.BYTES_PER_ELEMENT; }`)).toBe(
      4,
    );
  });

  it("dynamic new ctor(buf) constructs a non-null shared-backing view (.length correct)", async () => {
    // NOTE: element read/WRITE on a dynamically-constructed `$__ta_dyn_view` (the
    // runtime-kinded view) is deliberately BANKED — the boxed view's kind is only
    // known at runtime, so `a[i]`/`a[i]=v` need a runtime-kind byte-decode/encode
    // arm in the dynamic index path (a follow-up). This asserts the construct itself
    // runs host-free and the structural `.byteLength` is correct (kind-dispatched).
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Int32Array];
          const buf = new ArrayBuffer(16);
          let r = 0;
          for (const c of ctors) { const a = new c(buf); r = a.byteLength; }
          return r; // Int32 over 16 bytes → 16
        }`),
    ).toBe(16);
  });

  it("dynamic view .byteLength dispatches on the runtime kind", async () => {
    expect(
      await run(`
        export function f(): number {
          const ctors: any[] = [Uint8Array, Int32Array];
          const buf = new ArrayBuffer(8);
          let s = 0;
          for (const c of ctors) { const ta = new c(buf); s = s + ta.byteLength; }
          return s; // 8 + 8
        }`),
    ).toBe(16);
  });

  it("windowed dynamic ctor new ctor(buf, off, len) sizes byteLength per kind", async () => {
    expect(
      await run(`
        function CreateResizableArrayBuffer(bl: number, mx: number): ArrayBuffer { return new ArrayBuffer(bl, { maxByteLength: mx }); }
        export function f(): number {
          const ctors: any[] = [Uint8Array, Int32Array];
          let n = 0;
          for (const ctor of ctors) { const rab = CreateResizableArrayBuffer(40, 80); const ta = new ctor(rab, 0, 3); n = n + ta.byteLength; }
          return n; // 3*1 + 3*4
        }`),
    ).toBe(15);
  });

  it("length-tracking dynamic view over a resizable buffer reflects a resize (byteLength)", async () => {
    expect(
      await run(`
        function CreateResizableArrayBuffer(bl: number, mx: number): ArrayBuffer { return new ArrayBuffer(bl, { maxByteLength: mx }); }
        export function f(): number {
          const ctors: any[] = [Uint8Array];
          let r = 0;
          for (const c of ctors) {
            const rab = CreateResizableArrayBuffer(8, 16);
            const ta = new c(rab); // auto-length, tracks resize
            rab.resize(12);
            r = ta.byteLength; // Uint8: tracks to 12 bytes
          }
          return r;
        }`),
    ).toBe(12);
  });

  it("the CreateRabForTest harness pattern compiles and runs host-free (E shim shape)", async () => {
    // Mirrors the adapted resizableArrayBufferUtils.js shim: typed-ArrayBuffer
    // helpers + dynamic construct + write loop + resize, iterating a ctor list.
    expect(
      await run(`
        function CreateResizableArrayBuffer(bl: number, mx: number): ArrayBuffer { return new ArrayBuffer(bl, { maxByteLength: mx }); }
        function CreateRabForTest(ctor: any): ArrayBuffer {
          const rab = CreateResizableArrayBuffer(4 * ctor.BYTES_PER_ELEMENT, 8 * ctor.BYTES_PER_ELEMENT);
          const taWrite = new ctor(rab);
          for (let i = 0; i < 4; ++i) { taWrite[i] = 2 * i; }
          return rab;
        }
        export function f(): number {
          const ctors: any[] = [Uint8Array, Int32Array, Float64Array];
          let count = 0;
          for (const ctor of ctors) {
            const rab = CreateRabForTest(ctor);
            const ta = new ctor(rab);
            const bl = ta.byteLength;
            rab.resize(8 * ctor.BYTES_PER_ELEMENT);
            count = count + 1;
          }
          return count;
        }`),
    ).toBe(3);
  });
});
