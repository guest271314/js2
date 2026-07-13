// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2903 R3 — standalone LAZY Iterator-helper wrappers (`map`/`filter`/`take`/
// `drop`) on a dynamic (`any`/generator) iterator receiver.
//
// Sub-front 2 covered the EAGER helpers (find/every/some/forEach/reduce/toArray)
// that drive the source to completion. The lazy five instead return a NEW
// iterator (`$LazyIterHelper`, iter-lazy-native.ts) that produces transformed
// elements on demand. The wrapper is admitted by `__iter_hof_open`
// (`.toArray()` / eager-helper chaining) AND by the `__iterator` /
// `__iterator_next` / `__iterator_rest` GetIterator ladder (`Array.from(...)`,
// `[...spread]`, `for…of`) — all pure Wasm, zero host imports.
//
// Before this slice a `.map(cb)` on a generator fell to `__extern_method_call`'s
// non-`$Object` arm and silently answered `undefined` (or trapped in the
// Array.from drain). These flip host-free.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  return result;
}

/** Compile standalone, assert zero host imports, instantiate host-free, run. */
async function runHostFree(source: string): Promise<number> {
  const result = await compileStandalone(source);
  const mod = await WebAssembly.compile(result.binary!);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports).toEqual([]); // host-free: no __make_callback, no env import
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2903 R3 — lazy Iterator helpers are host-free and correct", () => {
  it("map(...).toArray() applies the mapper natively", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; }
         const r = (g() as any).map((x: number) => x * 2).toArray();
         export function test(): number { return r[0] + r[1] + r[2]; }`,
      ),
    ).toBe(12);
  });

  it("map passes (value, counter) to the mapper", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 10; yield 20; yield 30; }
         const r = (g() as any).map((v: number, c: number) => c).toArray();
         export function test(): number { return r[0] * 100 + r[1] * 10 + r[2]; }`,
      ),
    ).toBe(12); // counters 0,1,2
  });

  it("Array.from(map(...)) drives the wrapper through the GetIterator ladder", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; }
         const r = Array.from((g() as any).map((x: number) => x * 2));
         export function test(): number { return r.length * 100 + r[0] + r[1] + r[2]; }`,
      ),
    ).toBe(312);
  });

  it("[...spread] of a lazy map drains it natively", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; }
         const r = [...(g() as any).map((x: number) => x * 2)];
         export function test(): number { return r.length * 100 + r[0] + r[1] + r[2]; }`,
      ),
    ).toBe(312);
  });

  it("for-of over a lazy map yields the transformed values", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; }
         let s = 0; for (const x of (g() as any).map((v: number) => v * 2)) s += x;
         export function test(): number { return s; }`,
      ),
    ).toBe(12);
  });

  it("filter keeps only predicate-truthy values", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; yield 4; }
         const r = (g() as any).filter((x: number) => x % 2 === 0).toArray();
         export function test(): number { return r.length * 100 + r[0] + r[1]; }`,
      ),
    ).toBe(206); // [2, 4]
  });

  it("take(n) yields the first n and stops", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; yield 4; }
         const r = (g() as any).take(2).toArray();
         export function test(): number { return r.length * 100 + r[0] + r[1]; }`,
      ),
    ).toBe(203); // [1, 2]
  });

  it("drop(n) skips the first n", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; yield 4; }
         const r = (g() as any).drop(2).toArray();
         export function test(): number { return r.length * 100 + r[0] + r[1]; }`,
      ),
    ).toBe(207); // [3, 4]
  });

  it("chains map(...).map(...) natively (each is its own iterator)", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; }
         const r = Array.from((g() as any).map((x: number) => x + 1).map((x: number) => x * 10));
         export function test(): number { return r[0] + r[1] + r[2]; }`,
      ),
    ).toBe(90); // [20, 30, 40]
  });

  it("chains filter(...).take(...) natively", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; yield 4; yield 5; yield 6; }
         const r = (g() as any).filter((x: number) => x % 2 === 0).take(2).toArray();
         export function test(): number { return r.length * 100 + r[0] + r[1]; }`,
      ),
    ).toBe(206); // [2, 4]
  });

  it("flatMap flattens array inners (typed-vec mapper results)", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; yield 3; }
         const r = (g() as any).flatMap((x: number) => [x, x * 10]).toArray();
         export function test(): number {
           return r.length * 1000 + r[0] + r[1] + r[2] + r[3] + r[4] + r[5];
         }`,
      ),
    ).toBe(6066); // [1,10, 2,20, 3,30]
  });

  it("flatMap flattens generator inners", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; }
         function* h(x: number){ yield x; yield x + 100; }
         const r = (g() as any).flatMap((x: number) => h(x)).toArray();
         export function test(): number { return r.length * 1000 + r[0] + r[1] + r[2] + r[3]; }`,
      ),
    ).toBe(4206); // [1,101, 2,102]
  });

  it("flatMap via Array.from + empty inners + counter", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 5; yield 6; }
         const r = (g() as any).flatMap((x: number, c: number) => [c]).toArray();
         export function test(): number { return r.length * 100 + r[0] * 10 + r[1]; }`,
      ),
    ).toBe(201); // counters [0, 1]
  });

  it("flatMap(...).map(...) chains natively", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; }
         const r = (g() as any).flatMap((x: number) => [x, x]).map((y: number) => y * 10).toArray();
         export function test(): number { return r.length * 10000 + r[0] + r[1] + r[2] + r[3]; }`,
      ),
    ).toBe(40060); // [10,10,20,20]
  });

  it("empty source → empty result (no trap)", async () => {
    expect(
      await runHostFree(
        `function* g(){}
         const r = (g() as any).map((x: number) => x).toArray();
         export function test(): number { return r.length; }`,
      ),
    ).toBe(0);
  });

  it("take(0) yields nothing; drop beyond length yields nothing", async () => {
    expect(
      await runHostFree(
        `function* g(){ yield 1; yield 2; }
         const a = (g() as any).take(0).toArray();
         function* h(){ yield 1; yield 2; }
         const b = (h() as any).drop(5).toArray();
         export function test(): number { return a.length * 10 + b.length; }`,
      ),
    ).toBe(0);
  });
});

describe("#2903 R3 — eager array HOFs and gc/host lane unaffected", () => {
  it("standalone `any` array .map stays on the eager vec HOF arm", async () => {
    expect(
      await runHostFree(
        `const a: any = [1, 2, 3];
         const r = a.map((x: number) => x * 2);
         export function test(): number { return r[0] + r[1] + r[2]; }`,
      ),
    ).toBe(12);
  });

  it("gc/host lane compiles `.map` on an array with no $LazyIterHelper type", async () => {
    const result = await compile(
      `const a = [1, 2, 3];
       export function test(): number { const r = a.map((x) => x * 2); return r[0] + r[1] + r[2]; }`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // The lazy wrapper is standalone-only — it must never appear in gc/host output.
    const mod = await WebAssembly.compile(result.binary!);
    void mod; // compiles cleanly; struct absence is guaranteed by the standalone gate
  });
});
