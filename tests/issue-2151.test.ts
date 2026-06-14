// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2151 / board-task #25 — standalone any-receiver method dispatch over CLOSED
 * object-literal structs (Slice 1: zero-arg methods).
 *
 * `const o: any = { m(){…} }; o.m()` under --target standalone / --target wasi
 * used to return 0/undefined because the native any-receiver dispatch
 * (__extern_method_call) only handled the OPEN $Object receiver — a closed
 * object-literal struct fell to the ref.null.extern arm and the method never
 * ran. The fix routes 0-arg any-receiver calls through a per-name closed-struct
 * dispatcher (__call_m_<name>) that threads the struct as `this`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, target?: "wasi" | "standalone"): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", ...(target ? { target } : {}) });
  const io = (r as { importObject?: Record<string, unknown> }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, io as WebAssembly.Imports);
  (io as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  return (instance.exports.test as (() => unknown) | undefined)?.();
}

const TARGETS = ["standalone", "wasi"] as const;

describe("#2151 standalone any-receiver closed-struct method dispatch", () => {
  for (const target of TARGETS) {
    it(`${target}: o.next() invokes the closed-struct method`, async () => {
      const src = `export function test(): number { const o: any = { next() { return 7; } }; return (o.next() as number); }`;
      expect(await run(src, target)).toBe(7);
    });

    it(`${target}: this is threaded (o.getx())`, async () => {
      const src = `export function test(): number { const o: any = { x: 21, getx() { return this.x; } }; return (o.getx() as number); }`;
      expect(await run(src, target)).toBe(21);
    });

    it(`${target}: captured state persists across calls`, async () => {
      const src = `export function test(): number {
        function mk(){ let i=0; return { step(){ i=i+1; return i; } }; }
        const o: any = mk(); o.step(); o.step(); return (o.step() as number); }`;
      expect(await run(src, target)).toBe(3);
    });

    it(`${target}: custom iterable driven via any-method .next()`, async () => {
      const src = `
        const obj = { [Symbol.iterator]() { let i=0; return { next() { return i<3 ? {value:i++,done:false} : {value:undefined,done:true}; } }; } };
        export function test(): number {
          const it: any = obj[Symbol.iterator]();
          let sum=0; let g=0;
          while(true){ const r:any = it.next(); if (r.done) break; sum=sum*10+(r.value as number); if(++g>6) return -999; }
          return sum;
        }`;
      expect(await run(src, target)).toBe(12);
    });

    it(`${target}: class-instance method via any receiver`, async () => {
      const src = `class C { v=5; get5(){ return this.v; } } export function test(): number { const o:any = new C(); return (o.get5() as number); }`;
      expect(await run(src, target)).toBe(5);
    });
  }

  // Host mode must be byte-unaffected — same results via the JS-host path.
  it("host: o.next()/getx() unchanged", async () => {
    expect(
      await run(
        `export function test(): number { const o: any = { next() { return 7; } }; return (o.next() as number); }`,
      ),
    ).toBe(7);
    expect(
      await run(
        `export function test(): number { const o: any = { x: 21, getx() { return this.x; } }; return (o.getx() as number); }`,
      ),
    ).toBe(21);
  });
});
