import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

describe("#1623 extern.convert_any double-wrap on already-externref receiver", () => {
  it("emits valid Wasm for `this.#priv` in static method when #priv is set-only", async () => {
    const src = `
      class C {
        static set #f(v) { throw new Error(); }
        static getAccess() { return this.#f; }
      }
      C.getAccess;
      export function test(): number { return 1; }
    `;
    const r = await compile(src, { fileName: "t.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    // Validate the module compiles — instantiation may need host imports
    // but byte-level Wasm validation must succeed.
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });

  it("emits valid Wasm for `this.unknownProp` in a static method (extern_get fallback)", async () => {
    const src = `
      class C {
        static probe() { return (this as any).unknown; }
      }
      C.probe;
      export function test(): number { return 1; }
    `;
    const r = await compile(src, { fileName: "t.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });
});

describe("#1623 standalone destructuring null-throw emits valid Wasm", () => {
  // Two distinct codegen bugs surfaced at the destructuring null-throw guard
  // under `--target standalone` (nativeStrings mode), both producing modules
  // that fail Wasm validation before any user code runs:
  //
  //  1. The "Cannot destructure 'null' or 'undefined'" message and the
  //     __extern_get property-name keys were pushed via `global.get strIdx`
  //     where strIdx is the nativeStrings -1 sentinel (no real import global),
  //     lowering to `global.get 0xFFFFFFFF` ("Invalid global index").
  //  2. `buildDestructureNullThrow` lazily emitted the in-module
  //     `__new_TypeError` constructor mid-prologue, where it took a user
  //     function's reserved-but-unpushed array slot and got clobbered, leaving
  //     a dangling funcMap index ("throw expected externref, found call of
  //     type f64").
  //
  // Fix: `stringConstantExternrefInstrs` for the strings, and a pre-pass that
  // emits the WASI/standalone error constructors before any user function.

  it("nested function with untyped object-param destructuring validates", async () => {
    const src = `export function test(): number {
      function fn({ a, b }: any) { return 0; }
      fn({ a: 1, b: 2 });
      return 0;
    }`;
    const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });

  it("typed object destructuring (struct path) still validates", async () => {
    const src = `interface P { a: number; b: number; }
      export function fn({ a, b }: P): number { return a + b; }`;
    const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });
});
