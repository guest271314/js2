import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

// #1820: the IR path lowered `&&` / `||` to `i32.and` / `i32.or` and the
// ternary `a ? b : c` to Wasm `select` — all of which evaluate BOTH operands
// eagerly. That loses JS short-circuit semantics:
//   - `cond ? f() : g()` would call both `f()` and `g()`;
//   - `function fact(n){ return n <= 1 ? 1 : n * fact(n - 1) }` recursed at the
//     base case → unbounded recursion / stack overflow;
//   - `guard && risky()` ran `risky()` even when `guard` was false.
//
// Fix: lower `&&` / `||` and the ternary through a short-circuiting
// `IrInstrIf`, evaluating each arm/right-operand only on the branch that needs
// it. A companion fix in `lower.ts` makes the local-allocation pass recurse
// into the value-producing `if` arm buffers so SSA values defined inside an arm
// (e.g. a nested-ternary sub-result, or an arm carrier constant) get a Wasm
// local — without it the structured `if` carrier emission mis-targeted an
// unrelated local and produced invalid Wasm.
//
// These run through the IR path (`experimentalIR: true`) using the
// `importObject` the compiler builds, so number boxing imports resolve.

async function irRun(source: string, fn: string, args: ReadonlyArray<number | boolean>): Promise<unknown> {
  const r = await compile(source, { experimentalIR: true });
  expect(r.success, `IR compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(
    r.binary,
    (r as unknown as { importObject: WebAssembly.Imports }).importObject,
  );
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn](...args);
}

describe("#1820 IR path short-circuits && / || / ternary", () => {
  it("recursive ternary terminates at the base case (no eager else-arm recursion)", async () => {
    const src = `export function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }`;
    expect(await irRun(src, "fact", [1])).toBe(1);
    expect(await irRun(src, "fact", [5])).toBe(120);
    expect(await irRun(src, "fact", [10])).toBe(3628800);
  });

  it("simple ternary selects the right arm", async () => {
    const src = `export function f(c: boolean): number { return c ? 11 : 22; }`;
    expect(await irRun(src, "f", [true])).toBe(11);
    expect(await irRun(src, "f", [false])).toBe(22);
  });

  it("nested ternary lowers to valid Wasm and selects correctly", async () => {
    const src = `export function f(a: number): number { return a > 0 ? (a > 10 ? 100 : 10) : 0; }`;
    expect(await irRun(src, "f", [7])).toBe(10);
    expect(await irRun(src, "f", [15])).toBe(100);
    expect(await irRun(src, "f", [-1])).toBe(0);
  });

  it("ternary embedded in arithmetic", async () => {
    const src = `export function f(a: number): number { return 10 + (a > 0 ? a : -a); }`;
    expect(await irRun(src, "f", [-3])).toBe(13);
    expect(await irRun(src, "f", [5])).toBe(15);
  });

  it("&& yields the correct boolean for every combination", async () => {
    const src = `export function f(a: boolean, b: boolean): boolean { return a && b; }`;
    expect(await irRun(src, "f", [true, true])).toBe(1);
    expect(await irRun(src, "f", [true, false])).toBe(0);
    expect(await irRun(src, "f", [false, true])).toBe(0);
    expect(await irRun(src, "f", [false, false])).toBe(0);
  });

  it("|| yields the correct boolean for every combination", async () => {
    const src = `export function f(a: boolean, b: boolean): boolean { return a || b; }`;
    expect(await irRun(src, "f", [true, true])).toBe(1);
    expect(await irRun(src, "f", [true, false])).toBe(1);
    expect(await irRun(src, "f", [false, true])).toBe(1);
    expect(await irRun(src, "f", [false, false])).toBe(0);
  });
});
