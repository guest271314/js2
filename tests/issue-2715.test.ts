import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #2715 — Linear backend lowered bitwise operands and Uint8Array element stores
// with the TRAPPING `i32.trunc_f64_s`, so JS programs that rely on ToInt32 /
// ToUint8 of NaN / ±Infinity / out-of-range values trapped ("float
// unrepresentable in integer range") instead of producing the wrapped value.
// The fix routes those paths through a non-trapping ToInt32 (trunc_sat + modular
// reduction), mirroring the WasmGC backend.

async function runLinear(body: string): Promise<number> {
  const r = await compile(`export function test(): number { ${body} }`, { target: "linear" });
  if (!r.success) throw new Error("compile failed: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary);
  return (instance.exports as { test: () => number }).test();
}

describe("#2715 linear backend ToInt32 — bitwise ops do not trap", () => {
  const cases: Array<[string, number]> = [
    ["return (0 / 0) | 0;", (0 / 0) | 0],
    ["return (1 / 0) | 0;", (1 / 0) | 0],
    ["return (-1 / 0) | 0;", (-1 / 0) | 0],
    ["return 1e20 | 0;", 1e20 | 0],
    ["return 4294967297 | 0;", 4294967297 | 0],
    ["return 2147483648 | 0;", 2147483648 | 0],
    ["return 3.9 | 0;", 3.9 | 0],
    ["return -3.9 | 0;", -3.9 | 0],
    ["return 5 & 3;", 5 & 3],
    ["return 6 ^ 3;", 6 ^ 3],
    ["return 1 << 31;", 1 << 31],
    ["return -2.5 >> 1;", -2.5 >> 1],
    ["return (-1 >>> 0) === 4294967295 ? 1 : 0;", 1],
    ["return ~(0 / 0);", ~(0 / 0)],
    ["return ~3.2;", ~3.2],
  ];
  for (const [body, expected] of cases) {
    it(`${body.trim()} === ${expected}`, async () => {
      expect(await runLinear(body)).toBe(expected);
    });
  }
});

describe("#2715 linear backend bitwise compound assignment ToInt32", () => {
  it("x |= NaN keeps x (ToInt32(NaN)=0)", async () => {
    expect(await runLinear("let x = 5; x |= 0 / 0; return x;")).toBe(5);
  });
  it("x &= 255 wraps", async () => {
    expect(await runLinear("let x = 257; x &= 255; return x;")).toBe(1);
  });
  it("x <<= 31 produces INT_MIN", async () => {
    expect(await runLinear("let x = 1; x <<= 31; return x;")).toBe(1 << 31);
  });
});

describe("#2715 linear backend Uint8Array store ToUint8 — no trap", () => {
  it("u8[0] = NaN stores 0", async () => {
    expect(await runLinear("const u = new Uint8Array(1); u[0] = 0 / 0; return u[0];")).toBe(0);
  });
  it("u8[0] = Infinity stores 0", async () => {
    expect(await runLinear("const u = new Uint8Array(1); u[0] = 1 / 0; return u[0];")).toBe(0);
  });
  it("u8[0] = 257 wraps to 1", async () => {
    expect(await runLinear("const u = new Uint8Array(1); u[0] = 257; return u[0];")).toBe(1);
  });
  it("u8[0] = -1 wraps to 255", async () => {
    expect(await runLinear("const u = new Uint8Array(1); u[0] = -1; return u[0];")).toBe(255);
  });
});
