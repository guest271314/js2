// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3140 — standalone native Function.prototype.bind (`$__bound_fn` carrier).
//
// Before: (a) the typed route degraded to identity-bind (DROPPED partial args);
// (b) an `any`-typed receiver never routed at all (dispatcher → undefined, so
// `typeof bound !== "function"`). The test262 TypedArray harness binds every
// arg factory (`argFactory.bind(undefined, constructor)`), so every
// makeCtorArg-style test failed at the harness level. Now: bind mints
// `$__bound_fn {target, thisArg, boundArgs}`; `__apply_closure` carries an
// unwrap front-guard (bound args prepended, [[BoundThis]] wins, bound-of-bound
// composes); the bare dynamic call dispatch has an unwrap arm; the closure
// classifier counts the carrier callable.

async function run(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
  expect(imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#3140 standalone Function.prototype.bind", () => {
  it("any-receiver bind: typeof, partial-arg prepend, passthrough", async () => {
    expect(
      await run(`
        function mk(TA: any, x: any) { return x; }
        export function test(): number {
          const f: any = mk;
          const bound = f.bind(undefined, 42);
          if (typeof bound !== "function") return 1;
          const r = bound([5, 6]);
          if (r === undefined) return 2;
          return r.length === 2 && r[0] === 5 ? 9 : 3;
        }`),
    ).toBe(9);
  });

  it("typed-receiver bind keeps the partial args (was identity-bind)", async () => {
    expect(
      await run(`
        function add(a: number, b: number): number { return a + b; }
        export function test(): number {
          const add4: any = add.bind(undefined, 4);
          return add4(3) as number;
        }`),
    ).toBe(7);
  });

  it("the test262 TypedArray-harness bind flow works end-to-end", async () => {
    expect(
      await run(`
        function makePassthrough(TA: any, x: any) { return x; }
        function runWith(f: any, ctors: any) {
          let out = 0;
          const factories: any = [makePassthrough];
          for (let k = 0; k < factories.length; k++) {
            for (let i = 0; i < ctors.length; i++) {
              const constructor = ctors[i];
              const bound = factories[k].bind(undefined, constructor);
              out = f(constructor, bound);
            }
          }
          return out;
        }
        export function test(): number {
          return runWith(function(TA: any, makeCtorArg: any) {
            const a = new TA(makeCtorArg([0, 0, 0])).fill(8, 1);
            return a.length * 100 + a[1] * 10 + a[2];
          }, [Float64Array, Int8Array]);
        }`),
    ).toBe(388);
  });

  it("bound-of-bound composes (one unwrap hop per layer)", async () => {
    expect(
      await run(`
        function sum3(a: number, b: number, c: number): number { return a * 100 + b * 10 + c; }
        export function test(): number {
          const f: any = sum3;
          const g = f.bind(undefined, 1);
          const h = g.bind(undefined, 2);
          return h(3) as number;
        }`),
    ).toBe(123);
  });

  it("zero-partial bind is a plain callable wrapper", async () => {
    expect(
      await run(`
        function two(): number { return 2; }
        export function test(): number {
          const f: any = two;
          const b = f.bind(undefined);
          return typeof b === "function" ? (b() as number) : -1;
        }`),
    ).toBe(2);
  });

  it("bind on a non-callable any keeps the legacy undefined outcome (no hijack)", async () => {
    expect(
      await run(`
        export function test(): number {
          const notFn: any = { x: 1 };
          const b = notFn.bind(undefined, 1);
          return b === undefined ? 1 : 0;
        }`),
    ).toBe(1);
  });
});
