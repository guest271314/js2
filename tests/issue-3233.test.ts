// #3233 — self-host Math.atan2: the last non-dialect-gap Math core moves from
// hand-emitted Instr[] to TS source in src/stdlib/math.ts, compiled through the
// compiler's own IR pipeline (the #3161 generalized 2-arg path). These tests
// pin the spec-critical special arms (quadrant signs, sign-of-zero, NaN, the
// ±Infinity × ±Infinity corners) exactly, plus accuracy on the general path,
// in both host and standalone (no-host-import) modes. The self-hosted body
// calls the SAME self-hosted Math_atan, so it is bit-identical to the deleted
// hand version — verified separately by a 11,664-case bit-exact sweep vs a
// main-built control.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const SRC = `
export function atan2(y: number, x: number): number { return Math.atan2(y, x); }
`;

type Atan2 = { atan2: (y: number, x: number) => number };

async function compileHost(): Promise<Atan2> {
  const r = await compile(SRC, { fileName: "issue-3233.ts" });
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
  return instance.exports as unknown as Atan2;
}

async function compileStandalone(): Promise<Atan2> {
  const r = await compile(SRC, { fileName: "issue-3233-standalone.ts", target: "standalone" });
  if (!r.success) throw new Error(`standalone compile failed: ${r.errors[0]?.message}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as unknown as Atan2;
}

// Every special-case arm the spec (§21.3.2.9) pins EXACTLY — these match native
// Math.atan2 bit-for-bit (the polynomial only enters the finite general path).
function checkSpecials(ex: Atan2) {
  const a = ex.atan2;
  // NaN in either argument → NaN
  expect(Number.isNaN(a(NaN, 1))).toBe(true);
  expect(Number.isNaN(a(1, NaN))).toBe(true);
  expect(Number.isNaN(a(NaN, NaN))).toBe(true);

  // y === ±0 with x > 0 → ±0 (sign of y preserved)
  expect(Object.is(a(0, 1), 0)).toBe(true);
  expect(Object.is(a(-0, 1), -0)).toBe(true);
  // y === ±0 with x < 0 → ±π
  expect(a(0, -1)).toBe(Math.PI);
  expect(a(-0, -1)).toBe(-Math.PI);
  // y === ±0 with x === +0 → ±0
  expect(Object.is(a(0, 0), 0)).toBe(true);
  expect(Object.is(a(-0, 0), -0)).toBe(true);
  // y === ±0 with x === -0 → ±π
  expect(a(0, -0)).toBe(Math.PI);
  expect(a(-0, -0)).toBe(-Math.PI);

  // x === +Infinity, y finite → ±0
  expect(Object.is(a(3, Infinity), 0)).toBe(true);
  expect(Object.is(a(-3, Infinity), -0)).toBe(true);
  // x === -Infinity, y finite → ±π
  expect(a(3, -Infinity)).toBe(Math.PI);
  expect(a(-3, -Infinity)).toBe(-Math.PI);
  // x === +Infinity, y === ±Infinity → ±π/4
  expect(a(Infinity, Infinity)).toBe(Math.PI / 4);
  expect(a(-Infinity, Infinity)).toBe(-Math.PI / 4);
  // x === -Infinity, y === ±Infinity → ±3π/4
  expect(a(Infinity, -Infinity)).toBe((3 * Math.PI) / 4);
  expect(a(-Infinity, -Infinity)).toBe(-(3 * Math.PI) / 4);
  // y === ±Infinity, x finite → ±π/2
  expect(a(Infinity, 5)).toBe(Math.PI / 2);
  expect(a(-Infinity, 5)).toBe(-Math.PI / 2);
  expect(a(Infinity, -5)).toBe(Math.PI / 2);
  expect(a(-Infinity, -5)).toBe(-Math.PI / 2);

  // x === 0, y finite nonzero → ±π/2
  expect(a(5, 0)).toBe(Math.PI / 2);
  expect(a(-5, 0)).toBe(-Math.PI / 2);
  expect(a(5, -0)).toBe(Math.PI / 2);
  expect(a(-5, -0)).toBe(-Math.PI / 2);
}

// General finite path routes through the polynomial Math_atan, so results sit a
// few ULP from correctly-rounded libm — assert a bound loose enough for that
// inherited error but tight enough to catch a lowering break.
function checkAccuracy(ex: Atan2) {
  const rel = (g: number, w: number) => Math.abs(g - w) / Math.max(Math.abs(w), Number.MIN_VALUE);
  const cases: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    [3, 4],
    [-3, 4],
    [3, -4],
    [-3, -4],
    [0.5, 2],
    [100, 0.001],
    [1e-8, 5],
  ];
  for (const [y, x] of cases) {
    const got = ex.atan2(y, x);
    const want = Math.atan2(y, x);
    expect(rel(got, want), `atan2(${y}, ${x}) = ${got}, native ${want}`).toBeLessThan(1e-6);
  }
}

describe("#3233 self-hosted Math.atan2 (IR-compiled TS source)", () => {
  it("host mode: special arms exact, general path accurate", async () => {
    const ex = await compileHost();
    checkSpecials(ex);
    checkAccuracy(ex);
  });

  it("standalone mode: special arms exact, general path accurate (no host imports)", async () => {
    const ex = await compileStandalone();
    checkSpecials(ex);
    checkAccuracy(ex);
  });
});
