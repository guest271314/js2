// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2717 — Array.prototype.flat / flatMap have no standalone native arm.
 *
 * Both delegate to the host imports `__array_flat` / `__array_flatMap` with no
 * `ctx.standalone` guard. Under `--target standalone`/`wasi` there is no JS host
 * to satisfy those imports, so the emitted module FAILS TO INSTANTIATE.
 *
 * Per the #2711 fail-loud policy, the standalone/WASI path now refuses LOUDLY
 * (a tracked compile error) instead of emitting an unsatisfiable import. A full
 * Wasm-native flatten arm (recursive depth + runtime IsArray + dynamic
 * result-array build over heterogeneous WasmGC element types; flatMap also needs
 * callback invocation with mixed scalar/array returns) is a separate, larger
 * follow-up — the busy `Object()`/array-method surface isn't worth a risky
 * partial native flatten for a marginal test gain.
 *
 * Host/gc mode is byte-unchanged (the guard is gated on standalone||wasi).
 */

async function compileStandalone(body: string) {
  return compile(`export function test(): number { ${body} }`, { fileName: "t.ts", target: "standalone" });
}

describe("#2717 — flat/flatMap refuse loudly in standalone (no unsatisfiable import)", () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      "flat()",
      `const a: number[][] = [[1,2],[3,4]]; return a.flat().length;`,
      /flat\(\) is not yet supported in --target standalone/,
    ],
    [
      "flat(depth)",
      `const a: number[][] = [[1,2],[3,4]]; return a.flat(1).length;`,
      /flat\(\) is not yet supported in --target standalone/,
    ],
    [
      "flatMap()",
      `const a: number[] = [1,2,3]; return a.flatMap(x => [x, x*2]).length;`,
      /flatMap\(\) is not yet supported in --target standalone/,
    ],
  ];
  for (const [label, body, re] of cases) {
    it(`${label} → tracked compile error, never an unsatisfiable __array_flat* import`, async () => {
      const r = await compileStandalone(body);
      expect(r.success).toBe(false);
      const messages = r.errors.map((e) => e.message).join("\n");
      expect(messages).toMatch(re);
      // The guard runs BEFORE ensureLateImport, so the unsatisfiable host import
      // is never registered.
      const flatImports = r.imports.map((i) => i.name).filter((n) => n === "__array_flat" || n === "__array_flatMap");
      expect(flatImports).toEqual([]);
    });
  }
});

describe("#2717 — host/gc mode flat/flatMap unchanged", () => {
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
    ["flat() flattens one level", `const a: number[][] = [[1,2],[3,4]]; return a.flat().length;`, 4],
    ["flatMap() maps + flattens", `const a: number[] = [1,2,3]; return a.flatMap(x => [x, x*2]).length;`, 6],
  ];
  for (const [label, body, want] of cases) {
    it(`${label} → ${want}`, async () => {
      expect(await runHost(body)).toBe(want);
    });
  }
});
