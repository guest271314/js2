// #3075 — standalone for-of/for-await destructuring over legacy host-buffer
// generator objects: `illegal cast [in __iterator]`.
//
// Under `--target standalone`, a `yield*`-carrying (async) generator body
// bails to the legacy eager-buffer HOST runtime (`__create_generator` /
// `__create_async_generator` — see `sourceNeedsGeneratorHostImports`), so the
// generator object is a host-created external. The native `__iterator`
// GetIterator ladder had no arm for it: the value fell through every
// `ref.test` to the hard-cast tail and trapped `illegal cast` — 468 standalone
// records, dominated by the for-await-of `dstr-*-async-*` family (390 files).
//
// Fix (two halves):
//  1. iterator-native.ts — a HOSTGEN IterRec arm, filled at finalize exactly
//     when the module already carries the legacy `__gen_*` imports: a subject
//     that internalizes outside every GC subhierarchy (not struct/array/i31)
//     is its own iterator; `__iterator_next` drives it via `__gen_next` +
//     `__gen_result_done`/`__gen_result_value`, `__iterator_return` closes via
//     `__gen_return`. No new host import — the module has the bundle already.
//  2. runtime.ts — `__gen_yield_star` materializes a WasmGC `$Vec` operand
//     through the module's `__vec_len`/`__vec_get` exports before iterating
//     (it silently pushed ZERO values for a wasm-struct operand, so the fixed
//     iterator then drained an empty buffer).
//
// The module-level generator creation is deferred into `test()`-called code so
// `setExports` wiring (which `_materializeIterable` needs) is in place before
// the eager buffer builds — same ordering the test262 harness wrapper gives.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.errors ?? []).toEqual([]);
  const imports = buildImports(result.imports, undefined, result.stringPool, {}) as unknown as {
    setExports?: (e: unknown) => void;
  } & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  const testFn = instance.exports.test as () => number;
  return testFn();
}

describe("#3075 standalone for-await dstr over host-buffer async generators", () => {
  it("array pattern, single binding", async () => {
    const ret = await runStandalone(`
      let n = 0;
      function go() {
        var it = (async function*(){ yield* [[7]]; })();
        async function fn() { for await (const [v] of it) { n = v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(7);
  });

  it("array pattern, binding past the element's end reads undefined", async () => {
    const ret = await runStandalone(`
      let n = 0; let xok = 0;
      function go() {
        var it = (async function*(){ yield* [[]]; })();
        async function fn() {
          for await (const [_, x] of it) { if (x === undefined) xok = 1; n += 1; }
        }
        fn();
      }
      export function test() { go(); return n * 10 + xok; }
    `);
    expect(ret).toBe(11); // one iteration, x === undefined
  });

  it("array rest pattern drains the element", async () => {
    const ret = await runStandalone(`
      let n = 0;
      function go() {
        var it = (async function*(){ yield* [[1,2,3]]; })();
        async function fn() { for await (const [...xs] of it) { n = xs.length; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(3);
  });

  it("object pattern over a yielded object", async () => {
    const ret = await runStandalone(`
      let n = 0;
      function go() {
        var it = (async function*(){ yield* [{ w: 7 }]; })();
        async function fn() { for await (const { w } of it) { n = w; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(7);
  });

  it("plain (non-destructuring) for-await over the host gen iterates every element", async () => {
    const ret = await runStandalone(`
      let n = 0;
      function go() {
        var it = (async function*(){ yield* [7, 8]; })();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(15);
  });

  it("control: canonical array for-of destructuring is unchanged", async () => {
    const ret = await runStandalone(`
      let n = 0;
      export function test() {
        for (const [v] of [[1],[2]]) { n += v; }
        return n;
      }
    `);
    expect(ret).toBe(3);
  });
});
