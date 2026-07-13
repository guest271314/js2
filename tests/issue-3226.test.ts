// #3226 — self-host Math.exp / Math.pow / Math.log10: the last dialect-gap Math
// cores move from hand-emitted Instr[] to TS source in src/stdlib/math.ts,
// compiled through the compiler's own IR pipeline. #3226 established these need
// NO new dialect intrinsics (no i32 bit-ops / f64↔i64 reinterpret / f64.nearest):
//   - exp/pow: 2^n / exp-by-squaring reduce to pure-f64 parity+halve
//     (`ni - Math.floor(ni/2)*2`, `Math.floor(ni/2)`);
//   - log10: `f64.nearest` → `Math.floor(x+0.5)` (guard-equivalent within the
//     <1e-12 correction window, with a sign-of-zero fix-up).
// These tests pin the spec-critical specials + accuracy in host and standalone
// (no-host-import) modes. Bit-exactness vs a main-built control is proven
// separately by a ~10,900-case sweep (0 mismatches).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const SRC = `
export function exp(x: number): number { return Math.exp(x); }
export function log10(x: number): number { return Math.log10(x); }
export function pow(b: number, e: number): number { return Math.pow(b, e); }
`;

interface MathExports {
  exp: (x: number) => number;
  log10: (x: number) => number;
  pow: (b: number, e: number) => number;
}

async function compileHost(): Promise<MathExports> {
  const r = await compile(SRC, { fileName: "issue-3226.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: {},
    "wasm:js-string": {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) => s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    },
    string_constants: buildStringConstants(r.stringPool),
  } as WebAssembly.Imports);
  return instance.exports as unknown as MathExports;
}

async function compileStandalone(): Promise<MathExports> {
  const r = await compile(SRC, { fileName: "issue-3226-standalone.ts", target: "standalone" });
  if (!r.success) throw new Error(`standalone compile failed: ${r.errors[0]?.message}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as unknown as MathExports;
}

function checkSpecials(ex: MathExports) {
  // exp specials
  expect(Number.isNaN(ex.exp(NaN))).toBe(true);
  expect(ex.exp(Infinity)).toBe(Infinity);
  expect(ex.exp(-Infinity)).toBe(0);
  expect(ex.exp(0)).toBe(1);
  expect(ex.exp(710)).toBe(Infinity); // overflow (> 709.7)
  expect(ex.exp(-746)).toBe(0); // underflow (< -745)

  // log10 specials
  expect(Number.isNaN(ex.log10(NaN))).toBe(true);
  expect(Number.isNaN(ex.log10(-1))).toBe(true);
  expect(ex.log10(0)).toBe(-Infinity);
  expect(ex.log10(Infinity)).toBe(Infinity);
  expect(ex.log10(1)).toBe(0);
  // Positive powers of ten — the poly stays within the 1e-12 correction guard,
  // so the round-to-nearest-integer correction fires and returns EXACTLY the
  // integer. (Whether a given power lands inside the guard depends on the poly
  // error, so some large-|negative| powers return the raw uncorrected value —
  // bit-identical to the hand version, which is why the ~10,900-case sweep
  // passes; that behaviour is covered by the accuracy check below, not here.)
  for (let p = 1; p <= 15; p++) {
    expect(ex.log10(Math.pow(10, p)), `log10(1e${p})`).toBe(p);
  }
  // sign-of-zero just below 1 (the f64.nearest → floor(x+0.5) fix-up)
  expect(Object.is(ex.log10(0.999999999999), -0)).toBe(true);

  // pow specials (§21.3.2.26 ladder)
  expect(ex.pow(3, 0)).toBe(1);
  expect(ex.pow(NaN, 0)).toBe(1); // exp 0 wins even over NaN base
  expect(Number.isNaN(ex.pow(NaN, 2))).toBe(true);
  expect(Number.isNaN(ex.pow(2, NaN))).toBe(true);
  expect(Number.isNaN(ex.pow(1, Infinity))).toBe(true); // pow(±1, ±Inf) → NaN
  expect(Number.isNaN(ex.pow(-1, Infinity))).toBe(true);
  expect(ex.pow(1, 12345)).toBe(1);
  expect(ex.pow(5, 1)).toBe(5);
  expect(ex.pow(4, -1)).toBe(0.25);
  expect(ex.pow(9, 0.5)).toBe(3);
  expect(ex.pow(3, 2)).toBe(9);
  // exact integer exponentiation (the exp-by-squaring fast path)
  expect(ex.pow(3, 3)).toBe(27);
  expect(ex.pow(-3, 3)).toBe(-27);
  expect(ex.pow(-2, 10)).toBe(1024);
  expect(ex.pow(2, -3)).toBe(0.125);
  // signed-zero base
  expect(Object.is(ex.pow(-0, 3), -0)).toBe(true); // odd positive → -0
  expect(Object.is(ex.pow(-0, 2), 0)).toBe(true); // even → +0
  expect(ex.pow(-0, -3)).toBe(-Infinity);
  expect(ex.pow(0, -1)).toBe(Infinity);
  // infinite base
  expect(ex.pow(Infinity, 2)).toBe(Infinity);
  expect(ex.pow(Infinity, -1)).toBe(0);
  expect(ex.pow(-Infinity, 3)).toBe(-Infinity); // odd int
  expect(Object.is(ex.pow(-Infinity, -3), -0)).toBe(true);
  expect(ex.pow(-Infinity, 2)).toBe(Infinity); // even
  // negative base, non-integer exp → NaN
  expect(Number.isNaN(ex.pow(-2, 0.5))).toBe(true);
}

function checkAccuracy(ex: MathExports) {
  const rel = (g: number, w: number) => Math.abs(g - w) / Math.max(Math.abs(w), Number.MIN_VALUE);
  const expCases = [1, -1, 2.5, -2.5, 5, -5, 0.001, 100, -100];
  for (const v of expCases) {
    expect(rel(ex.exp(v), Math.exp(v)), `exp(${v})`).toBeLessThan(1e-8);
  }
  // log10 = log(x)·LOG10E inherits the shared Math_log polynomial's ~1e-7
  // relative error (identical to the hand version — bit-exactness is proven by
  // the sweep; this is a lowering-sanity floor, not a precision assertion).
  const log10Cases = [2, 3, 123.456, 0.5, 1e15, 1e-15];
  for (const v of log10Cases) {
    expect(rel(ex.log10(v), Math.log10(v)), `log10(${v})`).toBeLessThan(1e-7);
  }
  const powCases: [number, number][] = [
    [2, 10],
    [2.5, 3.3],
    [10, -2.5],
    [0.5, 8],
    [7, 0.333],
  ];
  for (const [b, e] of powCases) {
    expect(rel(ex.pow(b, e), Math.pow(b, e)), `pow(${b},${e})`).toBeLessThan(1e-6);
  }
}

describe("#3226 self-hosted Math.exp / log10 / pow (IR-compiled TS source)", () => {
  it("host mode: specials exact, general path accurate", async () => {
    const ex = await compileHost();
    checkSpecials(ex);
    checkAccuracy(ex);
  });

  it("standalone mode: specials exact, general path accurate (no host imports)", async () => {
    const ex = await compileStandalone();
    checkSpecials(ex);
    checkAccuracy(ex);
  });
});
