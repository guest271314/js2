// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2945 — IR lowering for `%` (modulo): capability row flipped defer → claim.
//
// Verify-first finding (recorded in the issue): the correct lowering is a
// call to the Wasm-native exact-remainder helper `__fmod` (#2056) — the SAME
// helper legacy's `emitModulo` emits — NOT the naive `a - trunc(a/b)*b`
// sequence (legacy tried that and replaced it: ULP drift, collapse-to-0 for
// large quotients, overflow to ±Inf). Because both paths call the identical
// helper, IR and legacy agree bit-for-bit on every edge case.
//
// Contract under test:
//   1. The selector CLAIMS `%` functions and the IR compiles them with zero
//      post-claim errors (the claim is backed by a lowering — #2135's
//      one-row-not-two-predicates invariant).
//   2. Spec-edge parity (tc39 §6.1.6.1.6 Number::remainder): sign follows
//      the dividend; `x % 0` → NaN; `Inf % x` → NaN; `x % Inf` → x;
//      `-0 % x` → -0; NaN propagates; large-quotient exactness.
//   3. Under JS2WASM_IR_FIRST=1 (the #2138 inversion) a `%` function
//      compiles and runs identically — the #2945 hard-error mode is gone
//      end-to-end (legacy body skipped, IR body ships, same results).
import { describe, expect, it, vi } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { binaryOpCapability } from "../src/ir/capability.js";
import { ts } from "../src/ts-api.js";

const MOD_SRC = `export function m(a: number, b: number): number { return a % b; }`;

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

async function compileFlag(irFirst: boolean, src: string): Promise<CompileResult> {
  // (#3143) IR-first is default-ON; off-arm uses the explicit "0" escape hatch.
  vi.stubEnv("JS2WASM_IR_FIRST", irFirst ? "1" : "0");
  try {
    return await compile(src, { fileName: "issue-2945.ts" });
  } finally {
    vi.unstubAllEnvs();
  }
}

/** JS ground truth via Object.is so -0 and NaN compare correctly. */
const EDGE_CASES: Array<[number, number]> = [
  [7, 3],
  [-7, 2], // sign of dividend: -1
  [7, -2], // sign of dividend: +1
  [7.5, 2],
  [-7.5, 2],
  [5, 0], // NaN
  [-0, 5], // -0
  [0, 5],
  [Infinity, 2], // NaN
  [-Infinity, 2], // NaN
  [2, Infinity], // 2
  [-2, Infinity], // -2
  [NaN, 2],
  [2, NaN],
  [1e308, 1e-308], // large-quotient exactness (naive formula overflows to ±Inf)
  [5.5, 5.5e-10], // ULP-drift trap for the naive formula
];

describe("#2945 IR `%` lowering via __fmod (capability defer → claim)", () => {
  it("capability row is claim and the selector claims `%` functions", () => {
    expect(binaryOpCapability(ts.SyntaxKind.PercentToken)).toBe("claim");
    const ast = analyzeSource(MOD_SRC);
    const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
    expect(sel.funcs.has("m")).toBe(true);
  });

  it("IR-compiles with zero post-claim errors and matches JS on every edge case", async () => {
    const r = await compileFlag(false, MOD_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect((r.irPostClaimErrors ?? []).filter((e) => e.func === "m")).toEqual([]);
    const exp = await instantiate(r);
    const m = exp.m as (a: number, b: number) => number;
    for (const [a, b] of EDGE_CASES) {
      const expected = a % b;
      expect(Object.is(m(a, b), expected), `m(${a}, ${b}) should be ${expected}, got ${m(a, b)}`).toBe(true);
    }
  });

  it("JS2WASM_IR_FIRST=1: `%` compiles clean (legacy body skipped), runs identically — the #2945 hard error is gone", async () => {
    const r = await compileFlag(true, MOD_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // The inversion actually skipped the legacy body — the IR body ships once.
    expect(r.irFirstSkipped).toContain("m");
    const exp = await instantiate(r);
    const m = exp.m as (a: number, b: number) => number;
    for (const [a, b] of EDGE_CASES) {
      expect(Object.is(m(a, b), a % b), `flag-on m(${a}, ${b})`).toBe(true);
    }
  });

  it("`%` inside a larger claimed closure keeps the whole closure on the IR path", async () => {
    // Regression guard for the call-graph interaction: pre-#2945 a helper
    // containing `%` was selector-rejected, which (bidirectional closure)
    // dragged its CALLERS off the IR path too. Now the pair stays claimed.
    const src = `
function wrap(a: number, b: number): number { return a % b; }
export function run(n: number): number { return wrap(n * 3 + 1, 7); }
`;
    const ast = analyzeSource(src);
    const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
    expect(sel.funcs.has("wrap")).toBe(true);
    expect(sel.funcs.has("run")).toBe(true);
    const r = await compileFlag(false, src);
    expect(r.success).toBe(true);
    expect(r.irPostClaimErrors ?? []).toEqual([]);
    const exp = await instantiate(r);
    expect((exp.run as (n: number) => number)(10)).toBe(31 % 7);
  });
});
