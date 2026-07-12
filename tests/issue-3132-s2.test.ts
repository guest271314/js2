// #3132 S2a — bounded async-generator CLASS METHOD drive (standalone).
//
// A class method `async *m() { … }` whose body never touches `this`/`super`/
// `arguments` routes through the same driven native producer as function
// declarations/expressions (`emitAsyncGenerator`), instead of the legacy
// eager-buffer HOST runtime — dropping the `__gen_*`/`__create_async_generator`
// import leak (the `method:zero-yield` bucket alone is 1,725 corpus files).
// Receiver-touching bodies keep the legacy path (correct-or-legacy).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.errors ?? []).toEqual([]);
  return result;
}

function genImportNames(result: { imports?: { name?: string; field?: string }[] }): string[] {
  return (result.imports ?? [])
    .map((i) => String(i.name ?? i.field ?? ""))
    .filter((n) => /__gen_|__create_generator|__create_async_generator/.test(n));
}

async function runStandalone(source: string): Promise<number> {
  const result = await compileStandalone(source);
  const imports = buildImports(result.imports, undefined, result.stringPool, {}) as unknown as {
    setExports?: (e: unknown) => void;
  } & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  return (instance.exports.test as () => number)();
}

describe("#3132 S2a — bounded async-gen class-method drive", () => {
  it("zero-yield instance method compiles host-free", async () => {
    const r = await compileStandalone(`
      class C { async *m() {} }
      function go() { new C().m(); }
      export function test() { go(); return 1; }
    `);
    expect(genImportNames(r)).toEqual([]);
  });

  it("plain-yield instance method drives for-await host-free", async () => {
    const r = await compileStandalone(`
      let n = 0;
      class C { async *m() { yield 4; yield 5; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(genImportNames(r)).toEqual([]);
    const imports = buildImports(r.imports, undefined, r.stringPool, {}) as unknown as {
      setExports?: (e: unknown) => void;
    } & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports);
    expect((instance.exports.test as () => number)()).toBe(9);
  });

  it("STATIC async-gen method drives host-free (the #2938 landmine path)", async () => {
    const ret = await runStandalone(`
      let n = 0;
      class C { static async *m() { yield 3; } }
      function go() {
        var it = C.m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(3);
  });

  it("yield* array-literal method body drives host-free (S1 unroll applies)", async () => {
    const ret = await runStandalone(`
      let n = 0;
      class C { async *m() { yield* [[6], [1]]; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const [v] of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(7);
  });

  it("a this-reading method body keeps the legacy host path (correct-or-legacy)", async () => {
    const r = await compileStandalone(`
      class C { v = 9; async *m() { yield this.v; } }
      function go() { new C().m(); }
      export function test() { go(); return 1; }
    `);
    expect(genImportNames(r)).not.toEqual([]);
  });
});
