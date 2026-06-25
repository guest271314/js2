// #2654 — Standalone parseFloat / Number(string) / __str_to_number decimal
// fraction precision.
//
// The native parse helpers accumulated the fraction as `mant += digit*0.1^k`
// (repeated `0.1` multiply, which is not exactly representable) and then
// re-scaled by a per-step `*10`/`/10` loop — compounding rounding error so that
// `parseFloat("0.3")` → 0.30000000000000004, `Number("0.01")` → 0.0100…2, etc.
//
// The fix accumulates ALL significant digits into a single exact i64 integer
// mantissa (`mant = mant*10 + digit`, capped at ~18 sig digits) tracking the
// decimal exponent, then applies `10^totalExp` in ONE correctly-rounded
// multiply/divide (single-power for |exp| ≤ 22; incremental fallback beyond,
// preserving the original extreme-exponent behaviour). Result: the standalone
// value now matches the host `parseFloat`/`Number` for every input within f64's
// resolvable precision.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runF64(expr: string, target?: "standalone" | "wasi"): Promise<number> {
  const opts: Record<string, unknown> = { fileName: "test.ts" };
  if (target) opts.target = target;
  const r = await compile(`export function test(): number { return ${expr}; }`, opts);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const imports = buildImports(r.imports, undefined, r.stringPool, {});
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => number)();
}

// Inputs whose correctly-rounded f64 value the OLD per-digit accumulation got
// wrong. Each must now equal the host's parse result exactly.
const PRECISION_INPUTS = [
  "0.3",
  "0.01",
  "0.001",
  "0.7",
  "99.99",
  "0.123456789",
  "123.456",
  ".01e2",
  ".01e+2",
  "3.141592653589793",
  "2.718281828459045",
  "0.000123456789012345",
  "123456789012345.6789",
  // ≥16 significant digits — exercises the i64 mantissa (would corrupt an f64
  // integer accumulation past 2^53).
  "1234567890.1234567890",
  "12345678901234567890",
  "9007199254740993",
];

describe("#2654 standalone decimal parse precision (parseFloat / Number)", () => {
  for (const input of PRECISION_INPUTS) {
    it(`parseFloat("${input}") matches host in standalone`, async () => {
      const host = Number.parseFloat(input);
      expect(await runF64(`parseFloat("${input}")`, "standalone")).toBe(host);
    });
    it(`Number("${input}") matches host in standalone`, async () => {
      const host = Number(input);
      expect(await runF64(`Number("${input}")`, "standalone")).toBe(host);
    });
  }

  it("wasi target shares the same correctly-rounded path", async () => {
    expect(await runF64(`parseFloat("0.3")`, "wasi")).toBe(0.3);
    expect(await runF64(`Number("99.99")`, "wasi")).toBe(99.99);
  });

  it("no regression: integers, exponents, hex, whitespace, sign", async () => {
    expect(await runF64(`Number("42")`, "standalone")).toBe(42);
    expect(await runF64(`Number("0xFF")`, "standalone")).toBe(255);
    expect(await runF64(`Number("1e3")`, "standalone")).toBe(1000);
    expect(await runF64(`parseFloat("  -3.5abc")`, "standalone")).toBe(-3.5);
    expect(await runF64(`parseInt("100", 16)`, "standalone")).toBe(256);
    expect(Number.isNaN(await runF64(`parseFloat("abc")`, "standalone"))).toBe(true);
  });

  it("no regression: extreme/subnormal exponents fall back gracefully", async () => {
    // Tiny subnormals must NOT flush to 0 (the incremental fallback handles them).
    expect(await runF64(`parseFloat("1e-310")`, "standalone")).toBe(1e-310);
    expect(await runF64(`parseFloat("5e-324")`, "standalone")).toBe(5e-324);
    // Large finite values stay finite (within 1 ULP — |exp| > 22 takes the
    // incremental fallback whose last-ULP behaviour matches the pre-#2654 code;
    // exact correctly-rounded extreme exponents would need full Eisel-Lemire,
    // out of scope. The point here is "no worse than before", not bit-exact).
    const big = await runF64(`parseFloat("1e300")`, "standalone");
    expect(Number.isFinite(big)).toBe(true);
    expect(Math.abs(big - 1e300) / 1e300).toBeLessThan(1e-15);
  });
});
