// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2734 — standalone Array search must find OBJECT elements by identity.
 *
 * Regression from #2719: that PR replaced the `__host_eq` / `__same_value_zero`
 * host imports in the standalone `indexOf`/`lastIndexOf`/`includes` arms with the
 * native `__extern_strict_eq` / `__extern_same_value_zero` helpers. Those compose
 * `__any_from_extern` + `__any_strict_eq`, but `__any_from_extern` has NO Object
 * tag — it folds an object externref into the tag-5 (string) fallback, so
 * `__any_strict_eq` string-compared two objects and never matched them by
 * identity. Result: standalone `[0, o].indexOf(o)` returned -1, regressing the
 * `built-ins/Array/prototype/{indexOf,lastIndexOf}/15.4.4.1{4,5}-*` object-element
 * cluster (20 tests) — surfaced only in the merge_group standalone floor, behind
 * a baseline that predated #2719.
 *
 * Fix: a `ref.eq` reference-identity fast path in `ensureExternStrictEqHelper`
 * (inherited by `__extern_same_value_zero`, which calls it). #2719's own tests
 * only covered string/number/NaN elements — this file closes the object-identity
 * gap. Host/gc mode is unaffected (the native helpers are standalone-only).
 */

async function runStandalone(body: string): Promise<number> {
  const r = await compile(`export function test(): number { ${body} }`, { fileName: "t.ts", target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2734 — standalone Array search finds object elements by identity", () => {
  const cases: Array<[string, string, number]> = [
    ["indexOf finds the object", `const o: any = {}; const a: any[] = [0, o, 1]; return a.indexOf(o);`, 1],
    ["lastIndexOf finds the object", `const o: any = {}; const a: any[] = [o, 1, o]; return a.lastIndexOf(o);`, 2],
    ["includes finds the object", `const o: any = {}; const a: any[] = [0, o]; return a.includes(o) ? 1 : 0;`, 1],
    [
      "indexOf distinct object → -1",
      `const a: any = {}; const b: any = {}; const arr: any[] = [0, a]; return arr.indexOf(b);`,
      -1,
    ],
    [
      "includes distinct object → false",
      `const a: any = {}; const b: any = {}; const arr: any[] = [0, a]; return arr.includes(b) ? 1 : 0;`,
      0,
    ],
    ["array element found by identity", `const o: any = [9]; const a: any[] = [0, o]; return a.indexOf(o);`, 1],
    // no regression on primitives:
    ["string element", `const a: any[] = [0, "y"]; return a.indexOf("y");`, 1],
    ["number element", `const a: any[] = [1, 2, 3]; return a.indexOf(2);`, 1],
    ["includes NaN (SameValueZero)", `const a: any[] = [NaN]; return a.includes(NaN) ? 1 : 0;`, 1],
    ["indexOf NaN (Strict Equality)", `const a: any[] = [NaN]; return a.indexOf(NaN);`, -1],
    ["miss → -1", `const a: any[] = [1, 2, 3]; return a.indexOf(4);`, -1],
  ];
  for (const [label, body, want] of cases) {
    it(`${label} → ${want}`, async () => {
      expect(await runStandalone(body)).toBe(want);
    });
  }
});

describe("#2734 — host/gc mode unaffected", () => {
  async function runHost(body: string): Promise<number> {
    const { buildImports } = await import("../src/runtime.js");
    const r = await compile(`export function test(): number { ${body} }`, { fileName: "t.ts" });
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    const built = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, built as WebAssembly.Imports);
    if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
    return (instance.exports as { test: () => number }).test();
  }
  it("host indexOf finds object by identity", async () => {
    expect(await runHost(`const o: any = {}; const a: any[] = [0, o]; return a.indexOf(o);`)).toBe(1);
  });
  it("host includes finds object by identity", async () => {
    expect(await runHost(`const o: any = {}; const a: any[] = [0, o]; return a.includes(o) ? 1 : 0;`)).toBe(1);
  });
});
