// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3058 (Bucket A, first slice) — read-side TypedArray proto-method dispatch on a
// boxed `$__ta_dyn_view` receiver (dynamic `new <ctorVar>(rab)` where the element kind
// is only known at runtime). #3057 wired element get/set on such a view; #3058 wires
// the runtime `ref.test $__ta_dyn_view` two-arm that (1) ValidateTypedArray (OOB →
// TypeError) and (2) materializes the view into an f64-vec copy and runs the ordinary
// f64-vec method impl. First slice: the host-import-free read methods `at`, `indexOf`,
// `lastIndexOf`, `includes`, `toLocaleString`. Host-enforced (the standalone floor does
// not enforce in-Wasm numeric asserts), so each program returns a number vitest checks.

async function run(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

async function moduleImports(src: string): Promise<string[]> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  return WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
}

const MK = `function mk(bl: number, mx: number): ArrayBuffer { return new ArrayBuffer(bl, { maxByteLength: mx }); }`;

describe("#3058 dynamic $__ta_dyn_view read-side proto-methods", () => {
  it(".indexOf finds the element index over a dynamic Int32 view (was -1)", async () => {
    expect(
      await run(`
        export function f(): number {
          const cs: any[] = [Int32Array];
          const b = new ArrayBuffer(16);
          let r = 0;
          for (const c of cs) { const a = new c(b); a[0]=11; a[1]=22; a[2]=33; a[3]=44; r = a.indexOf(33); }
          return r; // 2
        }`),
    ).toBe(2);
  });

  it(".indexOf honors a fromIndex argument", async () => {
    expect(
      await run(`
        export function f(): number {
          const cs: any[] = [Int32Array];
          const b = new ArrayBuffer(16);
          let r = 0;
          for (const c of cs) { const a = new c(b); a[0]=5; a[1]=5; a[2]=5; a[3]=9; r = a.indexOf(5, 1)*10 + a.indexOf(5, -1); }
          return r; // indexOf(5,1)=1 → 10 ; indexOf(5,-1)= -1 → 10 + (-1) = 9
        }`),
    ).toBe(9);
  });

  it(".at(-1) returns the last element (was 'illegal cast')", async () => {
    expect(
      await run(`
        export function f(): number {
          const cs: any[] = [Int32Array];
          const b = new ArrayBuffer(16);
          let r = 0;
          for (const c of cs) { const a = new c(b); a[0]=11; a[3]=44; r = a.at(-1); }
          return r; // 44
        }`),
    ).toBe(44);
  });

  it(".includes returns true/false over a dynamic Float64 view (was always false)", async () => {
    expect(
      await run(`
        export function f(): number {
          const cs: any[] = [Float64Array];
          const b = new ArrayBuffer(32);
          let r = 0;
          for (const c of cs) { const a = new c(b); a[2]=3.5; r = (a.includes(3.5) ? 1 : 0) * 10 + (a.includes(9.9) ? 1 : 0); }
          return r; // 10
        }`),
    ).toBe(10);
  });

  it(".lastIndexOf scans from the end", async () => {
    expect(
      await run(`
        export function f(): number {
          const cs: any[] = [Uint8Array];
          const b = new ArrayBuffer(8);
          let r = 0;
          for (const c of cs) { const a = new c(b); a[0]=9; a[5]=9; r = a.lastIndexOf(9); }
          return r; // 5
        }`),
    ).toBe(5);
  });

  it("a byteOffset (windowed) dynamic view reads the correct window", async () => {
    expect(
      await run(`
        export function f(): number {
          const cs: any[] = [Int32Array];
          const b = new ArrayBuffer(16);
          let r = 0;
          for (const c of cs) { const full = new c(b); full[0]=1; full[1]=2; full[2]=3; full[3]=4;
            const w = new c(b, 8, 2); r = w.indexOf(3)*10 + w.indexOf(4); }
          return r; // window = [3,4] → indexOf(3)=0 → 0 ; indexOf(4)=1 → 1
        }`),
    ).toBe(1);
  });

  it("length-tracking dynamic view: methods see the live element count", async () => {
    expect(
      await run(`
        ${MK}
        export function f(): number {
          const cs: any[] = [Int32Array];
          let r = 0;
          for (const c of cs) { const rab = mk(8, 160); const a = new c(rab); a[0]=5; a[1]=6; r = a.indexOf(6); }
          return r; // auto-length view over 2 Int32 → indexOf(6)=1
        }`),
    ).toBe(1);
  });

  it("ValidateTypedArray: a fixed view OOB after shrink throws a TypeError (§10.4.5.11)", async () => {
    expect(
      await run(`
        ${MK}
        export function f(): number {
          const cs: any[] = [Int32Array];
          let code = 0;
          for (const c of cs) {
            const rab = mk(16, 160);          // 4 Int32
            const a = new c(rab, 0, 4);       // fixed-length window over all 4
            a[0] = 7;
            rab.resize(8);                    // window needs 16 bytes → view OOB
            try { a.indexOf(7); } catch (e) { code = (e instanceof TypeError) ? 1 : 2; }
          }
          return code; // 1 — a TypeError instance, not a generic trap
        }`),
    ).toBe(1);
  });

  it("ValidateTypedArray: regrow restores in-bounds; the method works again", async () => {
    expect(
      await run(`
        ${MK}
        export function f(): number {
          const cs: any[] = [Int32Array];
          let code = 0;
          for (const c of cs) {
            const rab = mk(16, 160);
            const a = new c(rab, 0, 4);
            a[0] = 33;                                    // byte 0..4 — preserved across shrink-to-8
            rab.resize(8);
            let threw = 0;
            try { a.at(0); } catch (e) { threw = 1; }   // OOB → throws
            rab.resize(16);                               // regrow → in-bounds
            code = threw * 100 + a.indexOf(33);           // 100 + 0
          }
          return code; // 100
        }`),
    ).toBe(100);
  });

  it("HAZARD GUARD: a plain-array `any` receiver in the SAME module is unaffected", async () => {
    // Both a dyn view and a plain array reach the two-arm gate (both externref locals).
    // The runtime `ref.test $__ta_dyn_view` must fall through to the exact existing
    // plain-array method path when the receiver is not a dyn view.
    expect(
      await run(`
        export function f(): number {
          const cs: any[] = [Int32Array];
          const b = new ArrayBuffer(16);
          let s = 0;
          for (const c of cs) { const a = new c(b); a[1] = 5; s += a.indexOf(5); }  // dyn view → 1
          const p: any = [9, 8, 7];
          s += p.indexOf(7) * 10;                                                     // plain array → 2 → +20
          s += (p.includes(8) ? 1 : 0) * 100;                                         // plain array → +100
          return s; // 1 + 20 + 100 = 121
        }`),
    ).toBe(121);
  });

  it("byte-inert: a module with NO dynamic TA construct pulls no env import and still works", async () => {
    const src = `
      export function f(): number {
        const a: any = [3, 1, 2];
        return a.indexOf(2) + (a.includes(3) ? 10 : 0);
      }`;
    expect(await run(src)).toBe(2 + 10); // 12
    // The dyn-view two-arm is gated on the module pre-scan (moduleUsesDynTaView), so a
    // non-dyn-view module must emit ZERO of the new code — in particular no env import.
    expect(await moduleImports(src)).toEqual([]);
  });
});
