// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2719 — Array `indexOf` / `includes` / `lastIndexOf` on externref elements.
 *
 * The dedicated externref-element lowerings emitted the host imports `__host_eq`
 * (indexOf/lastIndexOf, Strict Equality §7.2.16) / `__same_value_zero` (includes,
 * SameValueZero §7.2.11) with no standalone branch, so a `--target standalone`
 * module referenced an unsatisfiable import and failed to instantiate.
 *
 * Fix: in standalone/WASI route element comparison through the pure-Wasm
 * `__extern_strict_eq` / `__extern_same_value_zero` helpers (composed from
 * `__any_from_extern` + `__any_strict_eq`). Host/gc mode keeps the host imports
 * unchanged. Additive — turns an unsatisfiable import into a self-contained
 * native search; results agree with the spec (incl. the NaN distinction:
 * `includes(NaN)` true, `indexOf(NaN)` false).
 */

async function runStandalone(body: string): Promise<{ value: number; hostImports: string[] }> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const hostImports = r.imports.map((i) => i.name).filter((n) => n === "__host_eq" || n === "__same_value_zero");
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const value = (instance.exports as { test: () => number }).test();
  return { value, hostImports };
}

describe("#2719 — externref-element Array search in standalone (no host imports)", () => {
  const cases: Array<[string, string, number]> = [
    ["indexOf hit", `const a: any[] = [1,"y",{}]; return a.indexOf("y");`, 1],
    ["indexOf miss", `const a: any[] = [1,"y",{}]; return a.indexOf("z");`, -1],
    ["indexOf number", `const a: any[] = [1,2,3]; return a.indexOf(2);`, 1],
    ["includes hit", `const a: any[] = [1,"y",{}]; return a.includes("y") ? 1 : 0;`, 1],
    ["includes miss", `const a: any[] = [1,"y",{}]; return a.includes("z") ? 1 : 0;`, 0],
    ["lastIndexOf hit", `const a: any[] = ["y",2,"y"]; return a.lastIndexOf("y");`, 2],
    ["lastIndexOf miss", `const a: any[] = ["y",2,"y"]; return a.lastIndexOf("q");`, -1],
    // NaN: Strict Equality (indexOf/lastIndexOf) NaN !== NaN; SameValueZero (includes) NaN === NaN.
    ["includes NaN (SameValueZero)", `const a: any[] = [NaN]; return a.includes(NaN) ? 1 : 0;`, 1],
    ["indexOf NaN (Strict Equality)", `const a: any[] = [NaN]; return a.indexOf(NaN);`, -1],
    ["lastIndexOf NaN (Strict Equality)", `const a: any[] = [NaN]; return a.lastIndexOf(NaN);`, -1],
  ];
  for (const [label, body, want] of cases) {
    it(`${label} → ${want}, no __host_eq/__same_value_zero import`, async () => {
      const { value, hostImports } = await runStandalone(body);
      expect(value).toBe(want);
      expect(hostImports).toEqual([]);
    });
  }
});

describe("#2719 — host/gc mode results unchanged", () => {
  async function runHost(body: string): Promise<number> {
    const { buildImports } = await import("../src/runtime.js");
    const r = await compile(`export function test(): number { ${body} }`, { fileName: "t.ts" });
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    const built = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, built as WebAssembly.Imports);
    if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
    return (instance.exports as { test: () => number }).test();
  }
  const cases: Array<[string, string, number]> = [
    ["indexOf hit", `const a: any[] = [1,"y",{}]; return a.indexOf("y");`, 1],
    ["includes NaN", `const a: any[] = [NaN]; return a.includes(NaN) ? 1 : 0;`, 1],
    ["indexOf NaN", `const a: any[] = [NaN]; return a.indexOf(NaN);`, -1],
    ["lastIndexOf hit", `const a: any[] = ["y",2,"y"]; return a.lastIndexOf("y");`, 2],
  ];
  for (const [label, body, want] of cases) {
    it(`${label} → ${want}`, async () => {
      expect(await runHost(body)).toBe(want);
    });
  }
});
