import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runFast(source: string, exportName = "test"): Promise<any> {
  const result = await compile(source, { fast: true });
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  return (instance.exports[exportName] as Function)();
}

async function run(source: string, exportName = "test"): Promise<any> {
  const result = await compile(source);
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  return (instance.exports[exportName] as Function)();
}

// #1825 — i32 fast-mode `%` must not emit a trapping i32.rem_s.
describe("#1825 — i32 fast-mode modulo does not trap", () => {
  it("normal modulo still works", async () => {
    expect(await runFast(`export function test(): number { return 10 % 3; }`)).toBe(1);
  });

  it("negative dividend modulo (sign of dividend)", async () => {
    expect(await runFast(`export function test(): number { return -7 % 3; }`)).toBe(-1);
  });

  it("modulo by zero does not trap (returns 0 in i32 mode)", async () => {
    // JS yields NaN; i32 fast mode has no NaN, so the guard returns 0 instead
    // of trapping the module.
    const src = `export function test(): number { let a = 10; let b = 0; return a % b; }`;
    expect(await runFast(src)).toBe(0);
  });

  it("INT_MIN % -1 does not trap (overflow guard, result 0)", async () => {
    const src = `export function test(): number { let a = -2147483648; let b = -1; return a % b; }`;
    expect(await runFast(src)).toBe(0);
  });

  it("modulo by zero with computed operands does not trap", async () => {
    const src = `export function test(): number {
      let total = 0;
      for (let i = 0; i < 4; i++) {
        let d = i - 2; // hits 0 when i === 2
        total = total + (10 % d);
      }
      return total;
    }`;
    // i=0: 10%-2=0 ; i=1: 10%-1=0 ; i=2: 10%0=0(guard) ; i=3: 10%1=0
    expect(await runFast(src)).toBe(0);
  });
});

// #1834 — element-write / length-set index uses saturating truncation.
describe("#1834 — vec write index uses saturating truncation", () => {
  it("arr.length = NaN does not trap", async () => {
    const src = `export function test(): number {
      const arr = [1, 2, 3];
      arr.length = NaN;
      return arr.length;
    }`;
    // trunc_sat(NaN) === 0
    expect(await run(src)).toBe(0);
  });

  it("arr.length = Infinity does not trap", async () => {
    const src = `export function test(): number {
      const arr = [1, 2, 3];
      arr.length = 1e30;
      return arr.length;
    }`;
    // trunc_sat clamps to i32 max instead of trapping
    expect(await run(src)).toBe(2147483647);
  });

  it("normal arr.length set still works", async () => {
    const src = `export function test(): number {
      const arr = [1, 2, 3, 4, 5];
      arr.length = 2;
      return arr.length;
    }`;
    expect(await run(src)).toBe(2);
  });
});
