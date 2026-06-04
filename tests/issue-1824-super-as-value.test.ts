// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1824 — a bare `super` used as a value reported the wrong static ValType.
 *
 * The SuperKeyword branch in `src/codegen/expressions.ts` emitted the correct
 * `local.get` for `this` (param 0) but read its type from `fctx.locals[selfIdx]`
 * — yet `this` is a *parameter*, so its ValType lives in `fctx.params`, not
 * `fctx.locals`. `fctx.locals[0]` is an unrelated non-param local (or
 * undefined → externref), which mis-drove downstream coercion of the `super`
 * receiver. The fix mirrors the ThisKeyword branch: params for param-range
 * indices, locals offset by the param count otherwise.
 *
 * Observable effect: methods that route through the super receiver
 * (`super.method()`, `super.prop`) compile to a valid module and return the
 * inherited value.
 */

async function run(source: string): Promise<number> {
  const r = await compile(source, {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as { test: () => number }).test();
}

describe("#1824 super used as a value has the correct static type", () => {
  it("super.method() returns the inherited method result", async () => {
    expect(
      await run(`
        class A { greet(): number { return 1; } }
        class B extends A { greet(): number { return super.greet() + 1; } }
        export function test(): number { return new B().greet(); }
      `),
    ).toBe(2);
  });

  it("super.method() observes the parent reading this.field", async () => {
    expect(
      await run(`
        class A { x: number = 5; getX(): number { return this.x; } }
        class B extends A { x: number = 9; getX(): number { return super.getX() * 2; } }
        export function test(): number { return new B().getX(); }
      `),
    ).toBe(18);
  });

  it("chained super calls across three levels compile and run", async () => {
    expect(
      await run(`
        class A { v(): number { return 1; } }
        class B extends A { v(): number { return super.v() + 10; } }
        class C extends B { v(): number { return super.v() + 100; } }
        export function test(): number { return new C().v(); }
      `),
    ).toBe(111);
  });
});
