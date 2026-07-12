// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3194 (bloat S4) — `compileSuperMethodCall` and `compileSuperElementMethodCall`
 * now share one core (`compileSuperMethodCallCore` in new-super.ts). Pure
 * dedup: the two `super.method(args)` / `super['method'](args)` forms differ
 * only in how the method name is obtained. These tests pin the equivalence of
 * the two forms (identical results through the shared core) across the paths the
 * refactor touched: normal inherited dispatch, multi-level ancestry, argument
 * padding / extra-arg side effects, and the void-return branch.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports ?? [], {});
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args);
}

describe("#3194 super-dispatch shared core", () => {
  it("super.method() and super['method']() give the same result", async () => {
    const src = `
      class A { add(x: number): number { return x + 10; } }
      class B extends A {
        viaDot(x: number): number { return super.add(x) * 2; }
        viaElem(x: number): number { return super["add"](x) * 2; }
      }
      export function dot(x: number): number { return new B().viaDot(x); }
      export function elem(x: number): number { return new B().viaElem(x); }
    `;
    expect(await run(src, "dot", [3])).toBe(26);
    expect(await run(src, "elem", [3])).toBe(26);
  });

  it("both forms walk multi-level ancestry to the resolved parent method", async () => {
    const src = `
      class A { base(x: number): number { return x + 1; } }
      class B extends A {}
      class C extends B {
        dot(x: number): number { return super.base(x); }
        elem(x: number): number { return super["base"](x); }
      }
      export function dot(x: number): number { return new C().dot(x); }
      export function elem(x: number): number { return new C().elem(x); }
    `;
    expect(await run(src, "dot", [41])).toBe(42);
    expect(await run(src, "elem", [41])).toBe(42);
  });

  it("both forms pad missing args and evaluate extra args for side effects", async () => {
    const src = `
      class A { sum(a: number, b: number): number { return a + b; } }
      class B extends A {
        dot(): number { return super.sum(5); }
        elem(): number { return super["sum"](5); }
      }
      export function dot(): number { return new B().dot(); }
      export function elem(): number { return new B().elem(); }
    `;
    // missing 2nd arg → padded default 0
    expect(await run(src, "dot")).toBe(5);
    expect(await run(src, "elem")).toBe(5);
  });

  it("void-return parent method: both forms return without leaving a value", async () => {
    const src = `
      class A { store(x: number): void {} }
      class B extends A {
        dot(x: number): number { super.store(x); return x; }
        elem(x: number): number { super["store"](x); return x; }
      }
      export function dot(x: number): number { return new B().dot(x); }
      export function elem(x: number): number { return new B().elem(x); }
    `;
    expect(await run(src, "dot", [7])).toBe(7);
    expect(await run(src, "elem", [7])).toBe(7);
  });
});
