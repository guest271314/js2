// #3141 — self-hosted stdlib pilot: the derived Math family (sinh/cosh/tanh,
// asinh/acosh/atanh, cbrt, expm1, log1p) is compiled from TS source in
// src/stdlib/math.ts through the compiler's own IR pipeline instead of
// hand-emitted Instr[]. These tests pin the spec-critical special values
// (sign-of-zero, NaN propagation, infinities, domain edges) and accuracy
// against native Math, in both host and standalone modes.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const SRC = `
export function cbrt(x: number): number { return Math.cbrt(x); }
export function sinh(x: number): number { return Math.sinh(x); }
export function cosh(x: number): number { return Math.cosh(x); }
export function tanh(x: number): number { return Math.tanh(x); }
export function asinh(x: number): number { return Math.asinh(x); }
export function acosh(x: number): number { return Math.acosh(x); }
export function atanh(x: number): number { return Math.atanh(x); }
export function expm1(x: number): number { return Math.expm1(x); }
export function log1p(x: number): number { return Math.log1p(x); }
`;

type MathExports = Record<string, (x: number) => number>;

async function compileHost(): Promise<MathExports> {
  const r = await compile(SRC, { fileName: "issue-3141.ts" });
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
  return instance.exports as MathExports;
}

async function compileStandalone(): Promise<MathExports> {
  const r = await compile(SRC, { fileName: "issue-3141-standalone.ts", target: "standalone" });
  if (!r.success) throw new Error(`standalone compile failed: ${r.errors[0]?.message}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as MathExports;
}

function checkSpecials(ex: MathExports) {
  // sign-of-zero preservation (§21.3.2.31 sinh, §21.3.2.34 tanh, cbrt, asinh, atanh, expm1, log1p)
  for (const f of ["cbrt", "sinh", "tanh", "asinh", "atanh", "expm1", "log1p"]) {
    expect(Object.is(ex[f]!(0), 0), `${f}(+0)`).toBe(true);
    expect(Object.is(ex[f]!(-0), -0), `${f}(-0)`).toBe(true);
  }
  // NaN propagation
  for (const f of ["cbrt", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh", "expm1", "log1p"]) {
    expect(Number.isNaN(ex[f]!(NaN)), `${f}(NaN)`).toBe(true);
  }
  // infinities
  expect(ex.cbrt!(Infinity)).toBe(Infinity);
  expect(ex.cbrt!(-Infinity)).toBe(-Infinity);
  expect(ex.sinh!(Infinity)).toBe(Infinity);
  expect(ex.sinh!(-Infinity)).toBe(-Infinity);
  expect(ex.cosh!(Infinity)).toBe(Infinity);
  expect(ex.cosh!(-Infinity)).toBe(Infinity);
  expect(ex.tanh!(Infinity)).toBe(1);
  expect(ex.tanh!(-Infinity)).toBe(-1);
  expect(ex.asinh!(Infinity)).toBe(Infinity);
  expect(ex.asinh!(-Infinity)).toBe(-Infinity);
  expect(ex.acosh!(Infinity)).toBe(Infinity);
  expect(ex.expm1!(Infinity)).toBe(Infinity);
  expect(ex.expm1!(-Infinity)).toBe(-1);
  expect(ex.log1p!(Infinity)).toBe(Infinity);
  // domain edges
  expect(Number.isNaN(ex.acosh!(0.999999))).toBe(true);
  expect(ex.acosh!(1)).toBe(0);
  expect(ex.atanh!(1)).toBe(Infinity);
  expect(ex.atanh!(-1)).toBe(-Infinity);
  expect(Number.isNaN(ex.atanh!(1.0000001))).toBe(true);
  expect(Number.isNaN(ex.log1p!(-1.5))).toBe(true);
  expect(ex.log1p!(-1)).toBe(-Infinity);
  // exact integer cube roots (Newton converges exactly here)
  expect(ex.cbrt!(27)).toBe(3);
  expect(ex.cbrt!(-27)).toBe(-3);
  expect(ex.cbrt!(8)).toBe(2);
}

function checkAccuracy(ex: MathExports) {
  // The pure-Wasm helpers are polynomial approximations, not correctly-
  // rounded libm (e.g. cosh via the shared Math_exp core sits ~2e-11
  // relative from native — inherited from the hand-written algorithm, which
  // the self-hosted sources mirror bit-for-bit). Assert a bound loose enough
  // for that inherent error but tight enough to catch real lowering breakage.
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), Number.MIN_VALUE);
  const cases: [string, number][] = [
    ["cbrt", 2.5],
    ["cbrt", -123.456],
    ["sinh", 1.5],
    ["cosh", -2.25],
    ["tanh", 0.75],
    ["asinh", 10],
    ["acosh", 3.5],
    ["atanh", 0.5],
    ["expm1", 1e-7],
    ["expm1", 2.5],
    ["log1p", 1e-6],
    ["log1p", 4.5],
  ];
  for (const [f, v] of cases) {
    const got = ex[f]!(v);
    const want = (Math as unknown as MathExports)[f]!(v);
    expect(rel(got, want), `${f}(${v}) = ${got}, native ${want}`).toBeLessThan(1e-8);
  }
}

describe("#3141 self-hosted Math builtins (IR-compiled TS source)", () => {
  it("host mode: specials and accuracy match", async () => {
    const ex = await compileHost();
    checkSpecials(ex);
    checkAccuracy(ex);
  });

  it("standalone mode: specials and accuracy match (no host imports)", async () => {
    const ex = await compileStandalone();
    checkSpecials(ex);
    checkAccuracy(ex);
  });
});
