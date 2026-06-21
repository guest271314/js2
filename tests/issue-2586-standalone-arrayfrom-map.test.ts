// #2586 — Array.from(Map) under --target standalone (pure-Wasm, host-free).
//
// A Map's default iterator is its `entries()` (§24.1.3.12 → §24.1.5.3), so
// `Array.from(map)` materializes one `[key, value]` pair per live entry.
//
// Before this fix, `Array.from(map)` under standalone fell through to the
// generic native `__iterator` drain, which is built VEC-ONLY and hard-casts
// its subject to a `$Vec` (iterator-native.ts) → `illegal cast` trap on the
// `ref $Map` struct. The fix routes Map through the SAME
// `emitCollectionIteratorVec` driver the `[...set]` / `.values()` paths use,
// in `"entries"` mode: it materializes a canonical externref `$Vec` whose slots
// are 2-element `$ObjVec` `[key, value]` pairs, handed back as a plain externref
// so the consumer reads it through the dynamic `__extern_get_idx`/`__extern_length`
// arm — exactly the host `__array_from` contract, with ZERO host imports.
//
// Each test compiles with `target: "standalone"`, asserts the module carries
// zero imports (fully native), and returns the expected value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `source` with `--target standalone`, run `test()`, return its value + import count. */
async function runStandalone(source: string): Promise<{ value: unknown; imports: number; valid: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).length;
  const imp = (result as unknown as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imp);
  (imp as unknown as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  const value = (instance.exports as { test: () => unknown }).test();
  return { value, imports, valid };
}

describe("#2586 Array.from(Map) standalone (host-free)", () => {
  it("length reflects entry count — host-import-free", async () => {
    const { value, imports, valid } = await runStandalone(
      `export function test(): number {
         const m = new Map<string, string>();
         m.set("k", "v");
         const a = Array.from(m);
         return a.length;
       }`,
    );
    expect(valid).toBe(true);
    expect(imports).toBe(0);
    expect(value).toBe(1);
  });

  it("string key + string value pair reads back", async () => {
    const { value, imports } = await runStandalone(
      `export function test(): boolean {
         const m = new Map<string, string>();
         m.set("k", "v");
         const a = Array.from(m);
         return a[0][0] === "k" && a[0][1] === "v";
       }`,
    );
    expect(imports).toBe(0);
    expect(value).toBe(1); // boolean true → i32 1
  });

  it("string key + number value pair reads back", async () => {
    const { value, imports } = await runStandalone(
      `export function test(): boolean {
         const m = new Map<string, number>();
         m.set("k", 5);
         const a = Array.from(m);
         return a[0][0] === "k" && a[0][1] === 5;
       }`,
    );
    expect(imports).toBe(0);
    expect(value).toBe(1);
  });

  it("multiple entries preserve insertion order", async () => {
    const { value, imports } = await runStandalone(
      `export function test(): boolean {
         const m = new Map<string, string>();
         m.set("a", "1");
         m.set("b", "2");
         const a = Array.from(m);
         return a.length === 2 && a[0][0] === "a" && a[1][0] === "b" && a[1][1] === "2";
       }`,
    );
    expect(imports).toBe(0);
    expect(value).toBe(1);
  });

  it("number keys and values", async () => {
    const { value, imports } = await runStandalone(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(1, 10);
         m.set(2, 20);
         const a = Array.from(m);
         return a[0][0] * 100 + a[1][1]; // 1*100 + 20 = 120
       }`,
    );
    expect(imports).toBe(0);
    expect(value).toBe(120);
  });

  // Regression guards — sibling Array.from paths must keep working host-free.
  it("regression: Array.from(Set) still native", async () => {
    const { value, imports } = await runStandalone(
      `export function test(): boolean {
         const s = new Set(["x", "y"]);
         const a = Array.from(s);
         return a[0] === "x" && a[1] === "y";
       }`,
    );
    expect(imports).toBe(0);
    expect(value).toBe(1);
  });

  it("regression: Array.from(array) copy still native", async () => {
    const { value, imports } = await runStandalone(
      `export function test(): boolean {
         const src = [1, 2, 3];
         const a = Array.from(src);
         return a.length === 3 && a[2] === 3;
       }`,
    );
    expect(imports).toBe(0);
    expect(value).toBe(1);
  });

  it("regression: Array.from(string) char split still native", async () => {
    const { value, imports } = await runStandalone(
      `export function test(): boolean {
         const a = Array.from("hi");
         return a.length === 2 && a[0] === "h";
       }`,
    );
    expect(imports).toBe(0);
    expect(value).toBe(1);
  });
});
