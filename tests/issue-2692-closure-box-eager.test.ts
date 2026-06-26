import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2692 — A mutable variable captured (written) by a nested `function`
// declaration is boxed into a ref cell. Previously the box was materialized
// LAZILY at the first capturing call site; when that site sat in a
// conditionally-skipped branch (a destructuring default's then-arm, an `if`,
// etc.) the box was never created, so every later read of the captured var
// dereferenced a null cell → NaN/garbage. This fix materializes the box EAGERLY
// at function-top during function-declaration hoisting. (Root cause: #2669.)

async function run(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const result = await compile(source, { fileName: "t.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  const anyImp = imports as unknown as { setExports?: (e: Record<string, unknown>) => void };
  if (anyImp.setExports) anyImp.setExports(instance.exports as Record<string, unknown>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args);
}

describe("#2692 — eager closure-capture box materialization", () => {
  it("captured counter in a NOT-taken branch leaves the var intact (core repro)", async () => {
    // The only call site to `k` is inside a branch that never runs; `c` must
    // still read 0, not NaN. This is the destructuring-free minimal repro.
    expect(
      await run(`export function test(): number {
        var c = 0;
        function k() { c += 1; }
        if (c > 100) { k(); }
        return c;
      }`),
    ).toBe(0);
  });

  it("captured counter is NOT incremented when an array-default is skipped", async () => {
    // Standard test262 dstr template: defaults present-valued, so counter() must
    // not run and initCount stays 0 (was NaN/garbage before the fix).
    expect(
      await run(`export function test(): number {
        var initCount = 0;
        function counter(): any { initCount += 1; return 9; }
        let [a = counter(), b = counter()] = [1, 2];
        return initCount + (a === 1 ? 0 : 100) + (b === 2 ? 0 : 1000);
      }`),
    ).toBe(0);
  });

  it("captured counter IS incremented when the array-default fires, exactly once each", async () => {
    expect(
      await run(`export function test(): number {
        var initCount = 0;
        function counter(): any { initCount += 1; return 9; }
        let [a = counter(), b = counter()] = [undefined, undefined];
        return initCount + (a === 9 ? 0 : 100) + (b === 9 ? 0 : 1000);
      }`),
    ).toBe(2);
  });

  it("unconditional capturing calls still mutate the shared box", async () => {
    expect(
      await run(`export function test(): number {
        var c = 0;
        function k() { c += 1; }
        k(); k(); k();
        return c;
      }`),
    ).toBe(3);
  });

  it("two nested functions capturing the same var share ONE box (no cell-of-cell)", async () => {
    expect(
      await run(`export function test(): number {
        var c = 0;
        function inc() { c += 1; }
        function add2() { c += 2; }
        inc(); add2(); add2();
        return c;
      }`),
    ).toBe(5);
  });

  it("let-TDZ capture: read after init sees the post-init value", async () => {
    expect(
      await run(`export function test(): number {
        function k(): number { return c + 1; }
        let c = 6;
        return k();
      }`),
    ).toBe(7);
  });

  it("captured function parameter mutated through a nested function", async () => {
    expect(
      await run(`function outer(p: number): number {
        function bump() { p += 1; }
        bump(); bump();
        return p;
      }
      export function test(): number { return outer(40); }`),
    ).toBe(42);
  });

  it("function declared inside a loop captures the function-scope binding once", async () => {
    expect(
      await run(`export function test(): number {
        var c = 0;
        for (let i = 0; i < 3; i++) { function k() { c += 1; } k(); }
        return c;
      }`),
    ).toBe(3);
  });

  it("nested generator capturing a mutable var observes the shared box", async () => {
    expect(
      await run(`export function test(): number {
        var c = 0;
        function* g() { c += 10; yield c; }
        const it = g();
        it.next();
        return c;
      }`),
    ).toBe(10);
  });

  // Companion audit (#2692): for-of-assignment writes to a target that is ALSO
  // written by a nested function (hence eagerly boxed) must go THROUGH the cell.
  it("for-of array-assign target also written by a nested fn (box-aware write)", async () => {
    expect(
      await run(`export function test(): number {
        var v = 0;
        function bump() { v += 100; }
        for ([v] of [[1], [2], [3]]) {}
        bump();
        return v;
      }`),
    ).toBe(103);
  });

  it("for-of object-assign target also written by a nested fn (box-aware write)", async () => {
    expect(
      await run(`export function test(): number {
        var x = 0;
        function bump() { x += 100; }
        for ({ x } of [{ x: 7 }, { x: 8 }, { x: 9 }]) {}
        bump();
        return x;
      }`),
    ).toBe(109);
  });

  it("for-of object-assign default into a boxed target (box-aware default write)", async () => {
    expect(
      await run(`export function test(): number {
        var x = 0;
        function bump() { x += 1; }
        for ({ x = 50 } of [{}]) {}
        return x;
      }`),
    ).toBe(50);
  });
});
