// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2744 — object [[Extensible]] / integrity-level queries route through the
// runtime for ALL object representations (arrays/vec refs, typed object structs,
// Date), not just `$Object`/externref. Previously the integrity codegen treated
// any non-externref argType as a primitive, so `Object.isExtensible(arr)` folded
// to a static 0 and `Object.isFrozen(struct)`/`isSealed(struct)` to a static 1.
//
// Also: the queries are answered by TestIntegrityLevel (§7.3.16) over the live
// descriptor table, so `preventExtensions` + `defineProperty(non-writable,
// non-configurable)` correctly reports `isFrozen`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary\nWAT:\n${result.wat}`);
  }
  const runtime = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtime as WebAssembly.Imports);
  const r = runtime as { setExports?: (e: Record<string, Function>) => void };
  if (r.setExports) r.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#2744 [[Extensible]] / integrity queries route for all object reps", () => {
  it("isExtensible is true for a fresh array (vec ref)", async () => {
    expect(await run(`export function test(){ const a=[0,1]; return Object.isExtensible(a)?1:0; }`)).toBe(1);
  });

  it("isExtensible is true for a fresh typed object struct", async () => {
    expect(await run(`export function test(){ const o={x:1,y:2}; return Object.isExtensible(o)?1:0; }`)).toBe(1);
  });

  it("isFrozen is false for a fresh array", async () => {
    expect(await run(`export function test(){ const a:number[]=[]; return Object.isFrozen(a)?1:0; }`)).toBe(0);
  });

  it("isSealed is false for a fresh struct", async () => {
    expect(await run(`export function test(){ const o={x:1}; return Object.isSealed(o)?1:0; }`)).toBe(0);
  });

  it("preventExtensions(array) then isExtensible is false (identity-preserving)", async () => {
    expect(
      await run(
        `export function test(){ const a=[0,1]; Object.preventExtensions(a); return Object.isExtensible(a)?1:0; }`,
      ),
    ).toBe(0);
  });

  it("freeze(array) then isFrozen is true", async () => {
    expect(await run(`export function test(){ const a=[0,1]; Object.freeze(a); return Object.isFrozen(a)?1:0; }`)).toBe(
      1,
    );
  });

  it("seal(struct) then isSealed is true", async () => {
    expect(
      await run(`export function test(){ const o={x:1,y:2}; Object.seal(o); return Object.isSealed(o)?1:0; }`),
    ).toBe(1);
  });

  it("isExtensible pre-check before seal is not order-blind", async () => {
    // The dropped static fold used to read the LATER seal() and fold the
    // earlier isExtensible to false; now it reads live runtime state.
    expect(
      await run(
        `export function test(){ const a=[0,1]; const pre = Object.isExtensible(a)?1:0; Object.seal(a); return pre; }`,
      ),
    ).toBe(1);
  });

  it("TestIntegrityLevel: preventExtensions + non-writable/non-config data prop => isFrozen", async () => {
    expect(
      await run(
        `export function test(){ const o:any={}; Object.defineProperty(o,"foo1",{value:20,writable:false,enumerable:false,configurable:false}); Object.preventExtensions(o); return Object.isFrozen(o)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("TestIntegrityLevel: preventExtensions + non-config accessor prop => isFrozen", async () => {
    expect(
      await run(
        `export function test(){ const o:any={}; function g(){return 10;} function s(v:any){} Object.defineProperty(o,"foo2",{get:g,set:s,configurable:false}); Object.preventExtensions(o); return Object.isFrozen(o)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("isFrozen/isSealed/isExtensible on a primitive keep spec answers", async () => {
    expect(await run(`export function test(){ return (Object.isFrozen(5 as any)?1:0); }`)).toBe(1);
    expect(await run(`export function test(){ return (Object.isSealed(5 as any)?1:0); }`)).toBe(1);
    expect(await run(`export function test(){ return (Object.isExtensible(5 as any)?1:0); }`)).toBe(0);
  });
});
