// #1103a — Wasm-native Map dispatch (standalone / nativeStrings).
//
// dev-1776 landed the dormant native Map runtime core (map-runtime.ts, PR
// #1072) — an ordered WasmGC hash table. This file is the regression net for
// the *wiring* that routes `new Map()` + `.set/.get/.has/.delete/.clear/.size`
// onto that runtime under `--target wasi`, instead of the `Map_*` host imports
// the externClass path would emit (which a pure-Wasm engine can't satisfy).
//
// Slice 1 scope: no-arg `new Map()`, number + native-string keys/values,
// get/set/has/delete/clear/size. for-of / forEach / `new Map(iterable)` are
// slice 2 and intentionally not covered here.
//
// Each test compiles with `target: "wasi"` and asserts (a) the module is valid
// Wasm, (b) it carries ZERO `Map_*` host imports (wiring routes onto the native
// runtime, not the host externClass path), and (c) it returns the expected
// value when instantiated against the WASI polyfill and run.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

/** Compile `source` with `--target wasi`, run `test()`, return its value. */
async function runMap(source: string): Promise<{ value: number; mapImports: number; valid: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const mapImports = WebAssembly.Module.imports(module).filter((i) => /^Map_/.test(i.name)).length;

  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, mapImports, valid };
}

describe("#1103a native Map dispatch (standalone)", () => {
  it("set + get for number keys/values — host-import-free", async () => {
    const { value, mapImports, valid } = await runMap(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(1, 10);
         m.set(2, 20);
         return (m.get(1) as number) + (m.get(2) as number);
       }`,
    );
    expect(valid).toBe(true);
    expect(mapImports).toBe(0);
    expect(value).toBe(30);
  });

  it("size + overwrite — host-import-free", async () => {
    const { value, mapImports, valid } = await runMap(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(1, 10);
         m.set(2, 20);
         m.set(1, 99); // overwrite, not a new entry
         return m.size; // 2
       }`,
    );
    expect(valid).toBe(true);
    expect(mapImports).toBe(0);
    expect(value).toBe(2);
  });

  it("has + delete + clear — host-import-free", async () => {
    const { value, mapImports, valid } = await runMap(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(1, 10);
         m.set(2, 20);
         let acc = 0;
         if (m.has(2)) acc += 100;       // 100
         if (m.delete(2)) acc += 1000;   // 1100
         if (!m.has(2)) acc += 10;       // 1110
         acc += m.size;                  // + 1  = 1111
         return acc;
       }`,
    );
    expect(valid).toBe(true);
    expect(mapImports).toBe(0);
    expect(value).toBe(1111);
  });

  it("string keys with number values — host-import-free", async () => {
    const { value, mapImports, valid } = await runMap(
      `export function test(): number {
         const m = new Map<string, number>();
         m.set("a", 1);
         m.set("b", 2);
         return (m.get("a") as number) + (m.get("b") as number) + m.size; // 1 + 2 + 2
       }`,
    );
    expect(valid).toBe(true);
    expect(mapImports).toBe(0);
    expect(value).toBe(5);
  });

  it("method-heavy program emits zero Map_* host imports and valid Wasm", async () => {
    const { mapImports, valid } = await runMap(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(1, 1); m.set(2, 2); m.set(3, 3);
         m.delete(2);
         m.has(1);
         m.clear();
         return m.size;
       }`,
    );
    expect(valid).toBe(true);
    expect(mapImports).toBe(0);
  });
});
