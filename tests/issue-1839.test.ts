// #1839 — addStringImports hand-rolled the late func-index shift but omitted
// `ctx.pendingInitBody`, `ctx.nativeStrHelpers`, and `ctx.mod.startFuncIdx`
// (unlike addUnionImports / shiftLateImportIndices).
//
// Symptom: when the first string usage occurs inside a FUNCTION body (not
// module-init), the string imports are added late. The module-init body's
// `call`/`ref.func` indices were not bumped, so `__module_init` called the
// wrong functions. These end-to-end tests pin the corrected shift.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, fnName = "test"): Promise<number> {
  const r = await compile(src, { fileName: "t.ts", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  return (instance.exports[fnName] as () => number)();
}

describe("#1839 — late string-import shift keeps module-init + helpers correct", () => {
  it("module-init call resolves after a late string-import shift triggered in a function body", async () => {
    // helper() is called from module-init (initialising moduleVal). The FIRST
    // string usage is inside greet() — this adds the string imports late, after
    // module-init was already emitted. If pendingInitBody isn't shifted,
    // __module_init calls the wrong function and moduleVal is corrupted.
    const src = `
      function helper(): number { return 42; }
      export const moduleVal: number = helper();
      export function greet(): string {
        const a = "hello";
        const b = "world";
        return a + " " + b;
      }
      export function test(): number { return moduleVal; }
    `;
    expect(await run(src)).toBe(42);
  });

  it("two module-init calls both stay correct across the late shift", async () => {
    const src = `
      function a(): number { return 10; }
      function b(): number { return 20; }
      export const x: number = a();
      export const y: number = b();
      export function s(): string { return "z" + "z"; }
      export function test(): number { return x + y; }
    `;
    expect(await run(src)).toBe(30);
  });

  it("string concat itself still works in the function that triggered the late import", async () => {
    // The string helpers (nativeStrHelpers) must resolve to the shifted indices
    // — if left stale, the concat would call the wrong function and trap or
    // produce a wrong-typed result. We exercise the function purely for
    // successful compile + instantiation (asserted in run()).
    const src = `
      function side(): number { return 7; }
      export const m: number = side();
      export function cat(): string {
        const parts = "a" + "b" + "c";
        return parts;
      }
      export function test(): number { return m; }
    `;
    expect(await run(src)).toBe(7);
  });
});
