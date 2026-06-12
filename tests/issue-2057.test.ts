// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2057 — `Math.min`/`Math.max` constant-folded a reassigned NaN-initialized
// variable to a compile-time NaN.
//
// `isStaticNaN` traced any identifier to its declaration initializer with no
// const-ness check, so `let x = NaN; x = 5; Math.min(x, 3)` was deemed
// "statically NaN" and folded to `f64.const NaN` — destroying the common
// NaN-initialized accumulator pattern. Fix: only follow the initializer for
// `const` declarations. The const fold (a sound optimization) is retained.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(src: string, fn: string, ...args: number[]): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as Record<string, (...a: number[]) => number>)[fn]!(...args);
}

describe("#2057 isStaticNaN only folds const NaN bindings", () => {
  it("reassigned let: Math.min sees the live value", async () => {
    const src = `export function t1(): number { let x = NaN; x = 5; return Math.min(x, 3); }`;
    expect(await run(src, "t1")).toBe(3); // Math.min(5, 3)
  });

  it("conditionally-assigned let: Math.max sees the live value", async () => {
    const src = `export function t2(b: boolean): number { let x = NaN; if (b) x = 10; return Math.max(x, 3); }`;
    expect(await run(src, "t2", 1)).toBe(10); // Math.max(10, 3)
  });

  it("genuinely-NaN let still yields NaN at runtime", async () => {
    // Never reassigned, so the runtime value really is NaN; Math.min(NaN, 3) === NaN.
    const src = `export function t3(): number { let x = NaN; return Math.min(x, 3); }`;
    expect(Number.isNaN(await run(src, "t3"))).toBe(true);
  });

  it("const NaN binding still folds (optimization retained)", async () => {
    const src = `export function t4(): number { const x = NaN; return Math.min(x, 3); }`;
    expect(Number.isNaN(await run(src, "t4"))).toBe(true);
  });

  it("literal NaN argument still folds", async () => {
    const src = `export function t5(): number { return Math.max(NaN, 7); }`;
    expect(Number.isNaN(await run(src, "t5"))).toBe(true);
  });
});
