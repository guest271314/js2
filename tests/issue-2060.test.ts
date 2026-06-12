// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2060 — `Math.hypot` was inlined as `sqrt(Σ aᵢ²)` with no scaling, so the
// squares overflowed to Infinity above ~1e154 and underflowed to 0 below
// ~1e-162, while JS engines compute hypot with scaling.
//
// Fix: scale by the largest magnitude m = max(|aᵢ|) and compute
// m * sqrt(Σ (aᵢ/m)²), guarding m == 0 → 0. Infinity/NaN propagation is
// preserved (Infinity short-circuit first; NaN flows through f64.max + the
// scaled arithmetic).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function hypot(args: number[]): Promise<number> {
  const params = args.map((_, i) => `a${i}: number`).join(", ");
  const call = args.map((_, i) => `a${i}`).join(", ");
  const src = `export function h(${params}): number { return Math.hypot(${call}); }`;
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as { h(...a: number[]): number }).h(...args);
}

function expectClose(got: number, exp: number): void {
  if (Number.isNaN(exp)) {
    expect(Number.isNaN(got)).toBe(true);
    return;
  }
  if (!Number.isFinite(exp)) {
    expect(got).toBe(exp);
    return;
  }
  // Within a few ULP — hypot exactness is implementation-approximated per spec.
  expect(Math.abs(got - exp)).toBeLessThanOrEqual(Math.abs(exp) * 1e-15);
}

describe("#2060 Math.hypot scales to avoid overflow/underflow", () => {
  it("no overflow at the top of the f64 range", async () => {
    expectClose(await hypot([1e200, 1e200]), Math.hypot(1e200, 1e200));
    expectClose(await hypot([1e200, 1e200, 1e200]), Math.hypot(1e200, 1e200, 1e200));
  });

  it("no underflow at the bottom of the f64 range", async () => {
    expectClose(await hypot([3e-200, 4e-200]), Math.hypot(3e-200, 4e-200));
  });

  it("ordinary magnitudes still exact", async () => {
    expectClose(await hypot([3, 4]), 5);
    expectClose(await hypot([-3, -4]), 5);
    expectClose(await hypot([2, 3, 6]), 7);
  });

  it("all-zero args return 0 (no 0/0 NaN from scaling)", async () => {
    expect(await hypot([0, 0])).toBe(0);
    expect(await hypot([0, 0, 0])).toBe(0);
  });

  it("Infinity and NaN propagation unchanged", async () => {
    expect(await hypot([Infinity, 1])).toBe(Infinity);
    expect(await hypot([NaN, Infinity])).toBe(Infinity); // Infinity wins per spec
    expect(Number.isNaN(await hypot([NaN, 1]))).toBe(true);
  });

  it("1-arg form returns the magnitude", async () => {
    expect(await hypot([-5])).toBe(5);
  });
});
