// #3132 (consumer foundation) — standalone async-generator CONSUMER drive.
//
// The async-gen PRODUCER already drives host-free (S1/S2a). The residual leak
// on `for await (const x of <async-gen source>)` was the CONSUMER:
//   1. `resolveAsyncGenNextHelperName` only resolved a direct NAMED call `g()`.
//      A var-held / IIFE async-gen FRAME (`var it = (async function*(){})();
//      for await (x of it)`) has an IDENTIFIER source → it returned null and the
//      consumer bailed to the legacy async-CPS path.
//   2. `calleeIsDriveLowered` was carrier-gated (WASI-only), so CALLING a driven
//      async-gen-consumer under `--target standalone` fell to the HOST
//      try/catch wrap (`Promise_reject` + `__get_caught_exception`).
// Both are fixed for the IDENTIFIER-binding source; the DSTR-head composition
// (over an async-gen source) stacks on #2996 as a follow-up PR.
//
// Destructuring-head for-await over an async-gen source stays on the legacy path
// here (correct-or-legacy) — asserted below as an explicit boundary.

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

function hostImportNames(result: { imports?: { name?: string; field?: string }[] }): string[] {
  return (result.imports ?? [])
    .map((i) => String(i.name ?? i.field ?? ""))
    .filter((n) =>
      /__gen_|__create_generator|__create_async_generator|__make_callback|Promise_|__get_caught_exception/.test(n),
    );
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

describe("#3132 consumer — standalone async-gen for-await drive (identifier binding)", () => {
  it("var-held async-gen frame, identifier binding compiles host-free", async () => {
    const r = await compileStandalone(`
      var asyncIter = (async function*() { yield 1; yield 2; yield 3; })();
      let out = 0;
      async function fn() { for await (const x of asyncIter) { out += x; } }
      export function test() { fn(); return out; }
    `);
    expect(hostImportNames(r)).toEqual([]);
  });

  it("var-held async-gen frame drives and accumulates correct values", async () => {
    expect(
      await runStandalone(`
        var asyncIter = (async function*() { yield 1; yield 2; yield 3; })();
        let out = 0;
        async function fn() { for await (const x of asyncIter) { out += x; } }
        export function test() { fn(); return out; }
      `),
    ).toBe(6);
  });

  it("inline async-gen call source, identifier binding is host-free and correct", async () => {
    const src = `
      async function* g() { yield 4; yield 5; }
      let out = 0;
      async function fn() { for await (const x of g()) { out += x; } }
      export function test() { fn(); return out; }
    `;
    expect(hostImportNames(await compileStandalone(src))).toEqual([]);
    expect(await runStandalone(src)).toBe(9);
  });

  it("yield*-array-literal producer, var-held, identifier binding is host-free and correct", async () => {
    const src = `
      var asyncIter = (async function*() { yield* [10, 20]; })();
      let out = 0;
      async function fn() { for await (const x of asyncIter) { out += x; } }
      export function test() { fn(); return out; }
    `;
    expect(hostImportNames(await compileStandalone(src))).toEqual([]);
    expect(await runStandalone(src)).toBe(30);
  });

  it("array-pattern destructuring head over async-gen source is host-free and correct", async () => {
    // Composes with #2996/#3228: the async-gen consumer CFG runs
    // IteratorBindingInitialization (compileForOfDestructuring) against the
    // settled element carrier — the shape of ~195 `async-func-dstr-*-async-*`
    // test262 files.
    const src = `
      var asyncIter = (async function*() { yield* [[1, 2, 3]]; })();
      let out = 0;
      async function fn() { for await (const [x, y, z] of asyncIter) { out += x + y + z; } }
      export function test() { fn(); return out; }
    `;
    expect(hostImportNames(await compileStandalone(src))).toEqual([]);
    expect(await runStandalone(src)).toBe(6);
  });

  it("object-pattern destructuring head over async-gen source is host-free and correct", async () => {
    const src = `
      var asyncIter = (async function*() { yield* [{ a: 2, b: 3 }]; })();
      let out = 0;
      async function fn() { for await (const { a, b } of asyncIter) { out += a * b; } }
      export function test() { fn(); return out; }
    `;
    expect(hostImportNames(await compileStandalone(src))).toEqual([]);
    expect(await runStandalone(src)).toBe(6);
  });

  it("inline async-gen call source, array pattern, multiple yields", async () => {
    const src = `
      async function* g() { yield [1, 2]; yield [3, 4]; }
      let out = 0;
      async function fn() { for await (const [p, q] of g()) { out += p + q; } }
      export function test() { fn(); return out; }
    `;
    expect(hostImportNames(await compileStandalone(src))).toEqual([]);
    expect(await runStandalone(src)).toBe(10);
  });
});
