// #2956 L1 — the linear backend consumes the IR front-end (flag-gated).
//
// Under `JS2WASM_LINEAR_IR=1`, selector-claimed numeric/control-flow
// top-level functions build IR once through the SHARED front-end
// (planIrCompilation → from-ast → verify → linear legality) and lower via
// `LinearEmitter` into the linear module's pre-assigned slots. Everything
// else demotes (bucketed) to the linear direct path. Flag off, the module
// is byte-identical to the pre-#2956 output.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";

const FLAG = "JS2WASM_LINEAR_IR";
const savedFlag = process.env[FLAG];
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

async function compileLinear(src: string, flag: boolean | "0"): Promise<Uint8Array> {
  if (flag === true) process.env[FLAG] = "1";
  else if (flag === "0") process.env[FLAG] = "0";
  else delete process.env[FLAG];
  const r = await compile(src, { target: "linear" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) throw new Error("compile failed");
  return r.binary;
}

async function run(binary: Uint8Array): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

async function exportedFunctions(binary: Uint8Array): Promise<Record<string, unknown>> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return instance.exports as unknown as Record<string, unknown>;
}

function callNumber(exports: Record<string, unknown>, name: string): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`missing export ${name}`);
  return (fn as () => number)();
}

const NUMERIC_SRC = `export function add(a: number, b: number): number { return a + b; }
export function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
export function loopSum(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { s = s + i; }
  return s;
}
export function test(): number { return add(fib(10), loopSum(5)); }`;

const VEC_SRC = `export function vecValue(): number {
  const values = [1.25, 2.5, 4.75];
  return values[1] + values.length;
}
export function vecAlias(): number {
  const values = [7, 11];
  const alias = values;
  return alias === values ? alias[0] + values[1] + alias.length : -1;
}
export function vecBounds(): number {
  const values = [3, 5];
  return values[99];
}
export function test(): number { return vecValue() + vecAlias() + vecBounds(); }`;

describe("#2956 L1: linear backend consumes IR for claimed numeric functions", () => {
  it("flag ON: claimed functions compile via IR (incl. self-recursion) and run correctly", async () => {
    const binary = await compileLinear(NUMERIC_SRC, true);
    const report = getLastLinearIrReport();
    expect(report).toBeDefined();
    // add / fib / loopSum / test are all numeric+control-flow: the whole
    // module compiles through the IR overlay (fib exercises the annotation
    // pre-seed for self-recursion; test exercises cross-function calls).
    expect([...(report?.compiled ?? [])].sort()).toEqual(["add", "fib", "loopSum", "test"]);
    expect(report?.rejected ?? []).toEqual([]);
    // fib(10)=55, loopSum(5)=10 → 65. Value parity with the direct path.
    expect(await run(binary)).toBe(65);
  });

  it("flag OFF is byte-identical (the overlay is inert)", async () => {
    const off1 = await compileLinear(NUMERIC_SRC, false);
    const on = await compileLinear(NUMERIC_SRC, true);
    const off2 = await compileLinear(NUMERIC_SRC, false);
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    expect(sha(off1)).toBe(sha(off2));
    // And the direct path still produces the same VALUE (65) as the IR path.
    expect(await run(off1)).toBe(65);
    expect(await run(on)).toBe(65);
  });

  it("value parity: IR-lowered and direct-path modules agree on results", async () => {
    const src = `export function collatzSteps(n: number): number {
      let steps = 0;
      let x = n;
      while (x !== 1) {
        if (x % 2 === 0) { x = x / 2; } else { x = 3 * x + 1; }
        steps = steps + 1;
      }
      return steps;
    }
    export function test(): number { return collatzSteps(27); }`;
    const on = await compileLinear(src, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled).toContain("collatzSteps");
    const off = await compileLinear(src, false);
    const vOn = await run(on);
    const vOff = await run(off);
    expect(vOn).toBe(vOff);
    expect(vOn).toBe(111); // collatz(27) takes 111 steps
  });

  it("out-of-scope shapes demote with a bucketed reason and still compile via the direct path", async () => {
    // String manipulation is outside the slice-1 legal set — the claim must
    // demote (reason bucket) and the DIRECT path must still produce a
    // working module (the overlay only ever adds capability).
    const src = `export function greet(name: string): string { return "hi " + name; }
    export function test(): number { return greet("x").length; }`;
    const binary = await compileLinear(src, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled ?? []).not.toContain("greet");
    if (report && report.rejected.length > 0) {
      for (const rej of report.rejected) {
        expect(rej.reason).toBeTruthy();
      }
    }
    expect(await run(binary)).toBe(4);
  });

  it("mutual recursion resolves through the annotation pre-seed", async () => {
    const src = `export function even(n: number): boolean { return n === 0 ? true : odd(n - 1); }
    export function odd(n: number): boolean { return n === 0 ? false : even(n - 1); }
    export function test(): number { return even(10) && odd(7) ? 1 : 2; }`;
    const binary = await compileLinear(src, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled).toContain("even");
    expect(report?.compiled).toContain("odd");
    expect(await run(binary)).toBe(1);
  });
});

describe("#2956 L2: selector-claimed vec construction", () => {
  it("flag ON lowers fixed number vecs with value, alias, and bounds parity", async () => {
    const directBinary = await compileLinear(VEC_SRC, false);
    const irBinary = await compileLinear(VEC_SRC, true);
    const report = getLastLinearIrReport();
    expect(report?.rejected ?? []).toEqual([]);
    expect([...(report?.compiled ?? [])].sort()).toEqual(["test", "vecAlias", "vecBounds", "vecValue"]);

    const direct = await exportedFunctions(directBinary);
    const ir = await exportedFunctions(irBinary);
    for (const name of ["vecValue", "vecAlias", "vecBounds", "test"]) {
      expect(callNumber(ir, name), `${name} IR value`).toBe(callNumber(direct, name));
    }
    expect(callNumber(ir, "vecValue")).toBe(5.5);
    expect(callNumber(ir, "vecAlias")).toBe(20);
    // The selector path reuses the direct runtime's bounds sentinel.
    expect(callNumber(ir, "vecBounds")).toBe(0);
  });

  it("JS2WASM_LINEAR_IR=0 keeps vec modules byte-identical to an unset flag", async () => {
    const unset = await compileLinear(VEC_SRC, false);
    const zero = await compileLinear(VEC_SRC, "0");
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    expect(sha(zero)).toBe(sha(unset));
  });

  it("unsupported hintless-empty construction stays on the direct fallback", async () => {
    const source = `export function emptyVec(): number {
      const values = [];
      return values.length;
    }
    export function test(): number { return emptyVec(); }`;
    const binary = await compileLinear(source, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled ?? []).not.toContain("emptyVec");
    expect(report?.rejected.some((rejection) => rejection.func === "emptyVec")).toBe(true);
    expect(await run(binary)).toBe(0);
  });
});
