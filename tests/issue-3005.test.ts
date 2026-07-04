// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3005 — Compiler stack-overflow on `(eval as any)()` (cast/parenthesized
// callee re-wrap recurses infinitely).
//
// In `compileCallExpression` the parenthesized-callee unwrap reaches the inner
// `AsExpression` (`eval as any`). `AsExpression` / `SatisfiesExpression` /
// `TypeAssertion` are NOT `LeftHandSideExpression`s and were NOT in the
// special-cased inner-shape set (conditional / comma / unary), so they fell
// through to the generic synthetic-call path, where
// `ts.factory.createCallExpression` re-wraps the callee in a
// `ParenthesizedExpression` to preserve precedence — producing an identical
// synthetic call and unbounded recursion (surfaced as a doubled
// "Internal error compiling expression: Maximum call stack size exceeded").
//
// The fix strips type-only callee wrappers alongside parentheses so the inner
// expression reaches its normal callee handling. A type cast is a compile-time
// no-op, so `(eval as any)()` behaves exactly like `eval()`, and
// `(fn as any)(args)` calls the real function.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  expect(result.success).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool) as Record<string, unknown> & {
    setExports?: (e: object) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as object);
  return (instance.exports as { main: () => unknown }).main();
}

describe("#3005 — cast/parenthesized callee no longer stack-overflows", () => {
  // The original crash: `(eval as any)(...)` must compile without an internal
  // RangeError (it now reaches the graceful eval-diagnostic path, like bare
  // `eval()`), NOT crash the compiler.
  for (const src of [
    "(eval as any)();",
    '(eval as any)("1+1");',
    "((eval as any))();",
    "(eval satisfies unknown)();",
  ]) {
    it(`compiles ${JSON.stringify(src)} without a compiler crash`, async () => {
      // Should not throw a RangeError / "Maximum call stack size exceeded".
      const result = await compile(src, { fileName: "test.ts" });
      // Whether it succeeds or emits a graceful eval diagnostic, it must NOT be
      // an internal compiler crash.
      const crashed = result.errors.some((e) => /Maximum call stack size|Internal error/.test(e.message));
      expect(crashed).toBe(false);
    });
  }

  // Type-wrapped callees that resolve to a real function must actually call it.
  it("`(fn as any)(args)` calls the underlying function", async () => {
    expect(await run("function f(x: number){ return x * 2; } export function main(){ return (f as any)(5); }")).toBe(
      10,
    );
  });

  it("`(obj.method as any)(args)` calls the underlying method", async () => {
    expect(
      await run(
        "function f(x: number){ return x + 1; } const o = { m: f }; export function main(){ return (o.m as any)(7); }",
      ),
    ).toBe(8);
  });

  it("`(fn satisfies T)(args)` calls the underlying function", async () => {
    expect(
      await run(
        "function f(x: number){ return x * 3; } export function main(){ return (f satisfies (x: number) => number)(9); }",
      ),
    ).toBe(27);
  });

  it("old-style `(<T>fn)(args)` type assertion calls the underlying function", async () => {
    expect(await run("function f(x: number){ return x - 1; } export function main(){ return (<any>f)(4); }")).toBe(3);
  });

  // Guard against regressing the sibling special-cased callee shapes that share
  // the same re-wrap hazard.
  it("conditional callee `(cond ? f : g)(args)` still works", async () => {
    expect(
      await run(
        "function g(a: number, b: number){ return a + b; } export function main(){ return (true ? g : g)(2, 3); }",
      ),
    ).toBe(5);
  });

  it("plain parenthesized callee `(fn)(args)` still works", async () => {
    expect(await run("function h(x: number){ return x * x; } export function main(){ return (h)(6); }")).toBe(36);
  });
});
