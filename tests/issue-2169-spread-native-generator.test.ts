// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2169 (SF-2 of #2157) — array spread of a Wasm-native generator.
 *
 * A top-level `function*` lowers (since #2079) to a native state struct
 * consumed correctly by `for-of`. But `[...g()]` treated that state struct as a
 * `__vec` (reading field 0 — actually `state` — as a `$length`), building a
 * garbage-length array of defaults and never calling `next()`. This slice
 * drains the generator via the native resume loop into an f64 vec
 * (`emitNativeGeneratorToVec`), then reuses the normal materialized-vec spread.
 *
 * Scope: array spread only. `Array.from(gen)` and array-destructuring
 * (`[a,b]=gen()`) are separate consumer call sites carried forward under #2169
 * (see the issue's "remaining" note); their `it.todo` gates live in
 * tests/issue-2157-iterator-generator-residual.test.ts.
 *
 * Every case must compile standalone with ZERO host imports and run correctly.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2169 array spread of a native generator", () => {
  it("spread length", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { const a=[...g()]; return a.length; }`),
    ).toBe(3);
  });

  it("spread values", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { const a=[...g()]; return a[0]*100 + a[1]*10 + a[2]; }`),
    ).toBe(123);
  });

  it("spread more than initial capacity (>4 yields exercises grow)", async () => {
    expect(
      await runStandalone(`function* g(){ yield 0; yield 1; yield 2; yield 3; yield 4; yield 5; }
export function test(): number { const a=[...g()]; let s=0; for (let i=0;i<a.length;i++) s+=a[i]; return s*1000 + a.length; }`),
    ).toBe(15006); // sum 0..5 = 15, length 6
  });

  it("spread of a control-flow generator", async () => {
    expect(
      await runStandalone(`function* g(){ let i=0; while(i<4){ if (i!==1) yield i; i++; } }
export function test(): number { const a=[...g()]; let s=0; for (let i=0;i<a.length;i++) s+=a[i]; return s*100 + a.length; }`),
    ).toBe(503); // values 0,2,3 → sum 5, length 3
  });

  it("mixed literal [head, ...gen]", async () => {
    expect(
      await runStandalone(`function* g(){ yield 3; yield 4; }
export function test(): number { const a=[0, ...g()]; return a.length*1000 + a[0]*100 + a[1]*10 + a[2]; }`),
    ).toBe(3034); // length 3, [0,3,4]
  });

  // Regression guards — non-generator spread paths must stay byte-identical.
  it("regression: array spread", async () => {
    expect(
      await runStandalone(`export function test(): number { const a=[1,2,3]; const b=[...a]; return b[0]+b[1]+b[2]; }`),
    ).toBe(6);
  });
  it("regression: string spread", async () => {
    expect(await runStandalone(`export function test(): number { const a=[..."abcd"]; return a.length; }`)).toBe(4);
  });
});
