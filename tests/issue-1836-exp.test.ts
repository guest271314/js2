// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1836 (exponential residual) — standalone Number.prototype.toString() must use
// exponential notation `d[.ddd]e±N` when the decimal point falls outside the
// (-6, 21] window (§6.1.6.1.20). Previously the standalone/WASI formatter had no
// exponential path, so (1e21).toString() rendered a 22-digit integer and
// (1e-7).toString() collapsed to "0". This slice normalises the mantissa into
// [1,10), emits 15 significant digits with round-half-up + trailing-zero trim,
// then 'e', the exponent sign, and the exponent magnitude (MSB-first).
//
// Bit-perfect shortest-round-trip (Grisu/Ryū) for 16-17-digit extremes near the
// double range boundaries (±1e308, denormals ~1e-308) remains #1335 Phase 2.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// Returns 1 iff (expr).toString() === expected, compared *inside* the module
// (native strings are GC i16 arrays, not JS strings, so we can't compare across
// the boundary directly).
async function eqStr(expr: string, expected: string): Promise<number> {
  const src = `export function test(): number { return ((${expr}).toString() === ${JSON.stringify(
    expected,
  )}) ? 1 : 0; }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#1836 standalone toString() exponential notation (§6.1.6.1.20)", () => {
  it("renders the large-magnitude regime (|x| >= 1e21) with e+N, not a long integer", async () => {
    expect(await eqStr("1e21", "1e+21")).toBe(1);
    expect(await eqStr("1e30", "1e+30")).toBe(1);
    expect(await eqStr("1.25e22", "1.25e+22")).toBe(1);
    expect(await eqStr("2.5e21", "2.5e+21")).toBe(1);
  });

  it("renders the small-magnitude regime (0 < |x| < 1e-6) with e-N, not '0'", async () => {
    expect(await eqStr("1e-7", "1e-7")).toBe(1);
    expect(await eqStr("1.5e-7", "1.5e-7")).toBe(1);
    expect(await eqStr("5e-7", "5e-7")).toBe(1);
    expect(await eqStr("1.234e-10", "1.234e-10")).toBe(1);
  });

  it("handles negative exponential values", async () => {
    expect(await eqStr("-1e21", "-1e+21")).toBe(1);
    expect(await eqStr("-1e-7", "-1e-7")).toBe(1);
  });

  it("rounds the last significant digit (round-half-up), not truncates", async () => {
    // 1.1e-7 and 9.5e-8 are not exactly representable; truncating 15 digits would
    // print 1.09999…e-7 / 9.49999…e-8. Round-half-up yields the V8 string.
    expect(await eqStr("1.1e-7", "1.1e-7")).toBe(1);
    expect(await eqStr("9.5e-8", "9.5e-8")).toBe(1);
    expect(await eqStr("4.9e-8", "4.9e-8")).toBe(1);
  });

  it("emits multi-digit exponents MSB-first (hundreds/tens/ones)", async () => {
    expect(await eqStr("1e100", "1e+100")).toBe(1);
    expect(await eqStr("1e-100", "1e-100")).toBe(1);
    expect(await eqStr("1e308", "1e+308")).toBe(1);
    expect(await eqStr("6.022e23", "6.022e+23")).toBe(1);
    expect(await eqStr("1.602e-19", "1.602e-19")).toBe(1);
  });

  it("does not switch to exponential at or inside the (-6, 21] boundary (no regression)", async () => {
    // 1e-6 stays fixed ("0.000001"); 9.999e20 < 1e21 stays a plain integer.
    expect(await eqStr("1e-6", "0.000001")).toBe(1);
    expect(await eqStr("1e-5", "0.00001")).toBe(1);
    expect(await eqStr("999900000000000000000", "999900000000000000000")).toBe(1);
  });

  it("leaves ordinary integer and fractional formatting unchanged (no regression)", async () => {
    expect(await eqStr("255", "255")).toBe(1);
    expect(await eqStr("100", "100")).toBe(1);
    expect(await eqStr("0", "0")).toBe(1);
    expect(await eqStr("3.14159", "3.14159")).toBe(1);
    expect(await eqStr("-42", "-42")).toBe(1);
  });
});
