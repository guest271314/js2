// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3274 (subtask of #3182, WAVE-B slice 3) — decomposition smoke test.
//
// Slice 3 extracted the prototype-chain helper-build block (~320 LOC:
// __getPrototypeOf, __object_create, __object_setPrototypeOf, __isPrototypeOf)
// VERBATIM from `ensureObjectRuntime` into `src/codegen/object-runtime-prototype.ts`
// (`buildObjectPrototypeHelpers`). The relocation is byte-identical (proved via
// scripts/prove-emit-identity.mjs: IDENTICAL across all 39 gc/standalone/wasi
// emits), so this is armor + a reachability check, NOT a behavioural change.
//
// The cases below exercise the extracted standalone-native `__object_create` +
// `__getPrototypeOf` helpers end to end (Object.create(null) + property
// store/read + getPrototypeOf), with ZERO host imports.

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

describe("#3274 slice 3 — prototype-chain helpers survive extraction (standalone-native)", () => {
  it("__object_create + __getPrototypeOf: Object.create(null) has a null prototype", async () => {
    const { result, envImports } = await runStandalone(
      "var o: any = Object.create(null); return Object.getPrototypeOf(o) === null ? 1 : 0;",
    );
    expect(result).toBe(1);
    expect(envImports).toEqual([]); // pure native path
  });

  it("__object_create: an object created with a null prototype stores + reads an own property", async () => {
    const { result } = await runStandalone("var o: any = Object.create(null); o.x = 5; return o.x;");
    expect(result).toBe(5);
  });

  it("__object_create: two own properties on a null-proto object are independent", async () => {
    const { result, envImports } = await runStandalone(
      "var o: any = Object.create(null); o.a = 3; o.b = 4; return o.a + o.b;",
    );
    expect(result).toBe(7);
    expect(envImports).toEqual([]);
  });
});
