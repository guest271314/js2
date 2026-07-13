// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2903 R1 — native standalone `new Promise(executorVALUE)` where the executor
// is NOT a syntactic inline arrow/function-expression (an identifier / param /
// any runtime closure value).
//
// The inline path (#2959, `emitStandalonePromiseFromExecutor`) needs the
// executor arrow's `ClosureInfo` to `call_ref` it. A value/param-held executor
// has no recoverable ClosureInfo, so on main it fell to the `Promise_new` host
// import (+ `__make_callback` + `Promise_then`) — un-instantiable host-free.
//
// R1 invokes the runtime executor value through the open-`any` closure bridge
// `__apply_closure(exec, undefined, [resolve, reject])` instead, retiring the
// host leak. The `resolve`/`reject` settle closures + throw-before-settle
// rejection are shared with the inline path.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const DRAIN = "declare function __drain_microtasks(): void;\n";

async function runHostFree(source: string): Promise<number> {
  const result = await compile(DRAIN + source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const mod = await WebAssembly.compile(result.binary!);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports).toEqual([]); // host-free: no Promise_new / __make_callback / Promise_then
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2903 R1 — new Promise(value executor) is host-free and correct", () => {
  it("resolves via a const-held executor", async () => {
    expect(
      await runHostFree(
        `export function test(): number {
           const ex = (res: any) => res(11);
           const p = new Promise(ex);
           let v = 0; p.then((x: any) => { v = x; });
           __drain_microtasks(); return v;
         }`,
      ),
    ).toBe(11);
  });

  it("resolves via a PARAM-held executor (the core R1 shape)", async () => {
    expect(
      await runHostFree(
        `function run(ex: any): number {
           const p = new Promise(ex);
           let v = 0; p.then((x: any) => { v = x; });
           __drain_microtasks(); return v;
         }
         export function test(): number { return run((res: any) => res(13)); }`,
      ),
    ).toBe(13);
  });

  it("routes a rejected value-executor through onRejected", async () => {
    expect(
      await runHostFree(
        `export function test(): number {
           const ex = (res: any, rej: any) => rej(4);
           const p = new Promise(ex);
           let v = 0; p.then((x: any) => { v = 1; }, (e: any) => { v = e; });
           __drain_microtasks(); return v;
         }`,
      ),
    ).toBe(4);
  });

  it("an executor that throws before settling rejects the promise", async () => {
    expect(
      await runHostFree(
        `export function test(): number {
           const ex = (res: any, rej: any) => { throw 8; };
           const p = new Promise(ex);
           let v = 0; p.then((x: any) => { v = 1; }, (e: any) => { v = e; });
           __drain_microtasks(); return v;
         }`,
      ),
    ).toBe(8);
  });

  it("a single-param executor (reject ignored) still resolves", async () => {
    expect(
      await runHostFree(
        `export function test(): number {
           const ex = (res: any) => res(7);
           const p = new Promise(ex);
           let v = 0; p.then((x: any) => { v = x; });
           __drain_microtasks(); return v;
         }`,
      ),
    ).toBe(7);
  });
});

describe("#2903 R1 — other lanes unaffected", () => {
  it("inline executor path is unchanged (still native, host-free)", async () => {
    expect(
      await runHostFree(
        `export function test(): number {
           const p = new Promise((res: any) => res(42));
           let v = 0; p.then((x: any) => { v = x; });
           __drain_microtasks(); return v;
         }`,
      ),
    ).toBe(42);
  });

  it("gc/host lane keeps the Promise_new host import for a value executor", async () => {
    const result = await compile(
      `function make(ex: any) { return new Promise(ex); }
       export function test(): number { const p = make((res: any) => res(1)); return 1; }`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const mod = await WebAssembly.compile(result.binary!);
    const names = WebAssembly.Module.imports(mod)
      .filter((i) => i.module === "env")
      .map((i) => i.name);
    expect(names).toContain("Promise_new"); // gc lane byte-unchanged (host executor path)
  });
});
