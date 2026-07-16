// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3270 — Break down + DRY closures.ts (subtask of #3182).
 *
 * This PR is a behaviour-preserving god-file split: it extracts four cohesive
 * subsystems out of `src/codegen/closures.ts` into `src/codegen/closures/`
 * (funcref-wrapper-types, callback-classification, funcref-as-closure,
 * method-trampolines) plus a shared `param-emit-helpers` leaf, and factors seven
 * copy-pasted emission idioms into shared helpers. The acceptance proof is the
 * prove-emit-identity byte-identity gate (39/39 emits IDENTICAL across gc /
 * standalone / wasi).
 *
 * This smoke test is the #2093 probe-coverage witness: small standalone programs
 * (host-free, so the WasmGC closure machinery is the ACTIVE path) that route
 * through each extracted cut / deduped helper:
 *
 *   - mutable + immutable closure captures → buildCaptureFieldDef, compileArrowAsClosure
 *   - arrow param destructuring + defaults → emitArrowParamDestructuring / spliceNullGuarded
 *   - nested fn-decl referenced as a value → emitFuncRefAsClosure / emitMemoizedNestedFnClosure
 *   - array HOF callbacks + stored closures → callback-classification (isHostCallbackArgument)
 *   - default-return-value tails                → emitDefaultReturnValue
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function numResult(body: string): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, {
    fileName: "issue-3270.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3270 closures.ts god-file split (standalone closure machinery)", () => {
  it("captures a mutable outer local through a ref cell", async () => {
    // compileArrowAsClosure + buildCaptureFieldDef (mutable, not-yet-boxed arm)
    expect(
      await numResult(`
        let count = 0;
        const inc = () => { count = count + 1; return count; };
        inc();
        inc();
        return inc();
      `),
    ).toBe(3);
  });

  it("captures an immutable value in a returned closure", async () => {
    // higher-order function returning a capture-carrying closure
    expect(
      await numResult(`
        function makeAdder(n: number): (x: number) => number {
          return (x: number) => x + n;
        }
        const add5 = makeAdder(5);
        return add5(10);
      `),
    ).toBe(15);
  });

  it("materializes a nested function declaration as a first-class closure value", async () => {
    // emitFuncRefAsClosure + emitMemoizedNestedFnClosure (nested decl captures `n`)
    expect(
      await numResult(`
        function outer(n: number): number {
          function inner(): number { return n * 2; }
          const f = inner;
          return f() + f();
        }
        return outer(6);
      `),
    ).toBe(24);
  });

  it("applies an arrow array-destructuring param default", async () => {
    // emitArrowParamDestructuring array path + emitDefaultReturnValue
    expect(
      await numResult(`
        const g = ([x, y = 9]: number[]): number => x + y;
        return g([4]);
      `),
    ).toBe(13);
  });

  it("runs an array HOF closure callback", async () => {
    // callback-classification: array-method callback → GC closure path
    expect(
      await numResult(`
        const arr = [1, 2, 3];
        const doubled = arr.map((x) => x * 2);
        return doubled[0] + doubled[1] + doubled[2];
      `),
    ).toBe(12);
  });

  it("stores a closure in an array and invokes it later", async () => {
    // isHostCallbackArgument: push stores the closure as a struct, read-site dispatches it
    expect(
      await numResult(`
        const fns: Array<() => number> = [];
        fns.push(() => 42);
        return fns[0]();
      `),
    ).toBe(42);
  });

  it("preserves closure identity for a memoized nested declaration", async () => {
    // emitMemoizedNestedFnClosure: every reference yields the SAME struct instance
    expect(
      await numResult(`
        function host(): number {
          function nested(): number { return 1; }
          const a = nested;
          const b = nested;
          return a === b ? 1 : 0;
        }
        return host();
      `),
    ).toBe(1);
  });
});
