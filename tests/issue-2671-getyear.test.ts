// #2671 (ES2015 Date residual) — Annex B §B.2.4 `Date.prototype.getYear()`.
//
// `getYear` (legacy, `getFullYear() - 1900`) was MISSING from the Date method
// dispatch (DATE_METHODS / DATE_PROTO_METHODS) and codegen, so `d.getYear()`
// returned undefined/null. `setYear` already existed; this adds the matching
// getter. NaN-guarded like the other getters.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2671 — Date.prototype.getYear (Annex B §B.2.4)", () => {
  it("getYear() of the epoch is 70 (1970 - 1900)", async () => {
    const exp = await run(`return new Date(0).getYear();`);
    expect(exp.test()).toBe(70);
  });

  it("getYear() is getFullYear() - 1900", async () => {
    const exp = await run(`return new Date(Date.UTC(2000, 0, 1)).getYear();`);
    expect(exp.test()).toBe(100);
  });

  it("getYear() is negative for years before 1900", async () => {
    const exp = await run(`return new Date(Date.UTC(1899, 0, 1)).getYear();`);
    expect(exp.test()).toBe(-1);
  });

  it("getYear() of an invalid Date is NaN", async () => {
    const exp = await run(`var y = new Date(NaN).getYear(); return (y !== y) ? 1 : 0;`);
    expect(exp.test()).toBe(1); // NaN !== NaN
  });

  it("setYear then getYear round-trips (Annex B legacy pair)", async () => {
    const exp = await run(`var d = new Date(0); d.setYear(98); return d.getYear();`);
    expect(exp.test()).toBe(98);
  });

  it("getFullYear still works (no regression to the canonical getter)", async () => {
    const exp = await run(`return new Date(0).getFullYear();`);
    expect(exp.test()).toBe(1970);
  });
});
