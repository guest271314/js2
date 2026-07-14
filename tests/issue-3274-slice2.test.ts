// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3274 (subtask of #3182, WAVE-B slice 2) — decomposition smoke test.
//
// Slice 2 extracted the enumeration / array-like / object-static helper-build
// block (~1,137 LOC: __object_keys/_forin, __extern_length/_get_idx/_has_idx,
// __object_values/_entries, __object_assign, __object_is) VERBATIM from
// `ensureObjectRuntime` into `src/codegen/object-runtime-enumeration.ts`
// (`buildObjectEnumerationHelpers`). The relocation is byte-identical (proved
// via scripts/prove-emit-identity.mjs: IDENTICAL across all 39 gc/standalone/wasi
// emits), so this is armor + a reachability check, NOT a behavioural change.
//
// The cases below exercise two of the extracted standalone-native helpers end to
// end: `__object_is` (SameValue — the NaN and +0/-0 edge cases distinguish it
// from `===`) and `__extern_length` (array-like `.length`), with ZERO host
// imports.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<{ result: number; envImports: string[] }> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const result = (instance.exports as { test(): number }).test();
  return { result, envImports };
}

describe("#3274 slice 2 — enumeration/object-static helpers survive extraction (standalone-native)", () => {
  it("__object_is: SameValue is true for equal numbers, false for distinct", async () => {
    expect((await runStandalone("return Object.is(5, 5) ? 1 : 0;")).result).toBe(1);
    expect((await runStandalone("return Object.is(5, 6) ? 1 : 0;")).result).toBe(0);
  });

  it("__object_is: SameValue(NaN, NaN) is true (unlike ===)", async () => {
    const { result, envImports } = await runStandalone("return Object.is(NaN, NaN) ? 1 : 0;");
    expect(result).toBe(1);
    expect(envImports).toEqual([]); // pure native path
  });

  it("__object_is: SameValue(+0, -0) is false (unlike ===)", async () => {
    expect((await runStandalone("return Object.is(0, -0) ? 1 : 0;")).result).toBe(0);
  });

  it("__extern_length: array-like .length reads back the element count", async () => {
    const { result, envImports } = await runStandalone("var a: any = [1, 2, 3]; return a.length;");
    expect(result).toBe(3);
    expect(envImports).toEqual([]);
  });
});
