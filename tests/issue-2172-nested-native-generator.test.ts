// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2172 (SF-1 of #2157) — no-capture nested `function*` lowers to the
 * Wasm-native generator in standalone / WASI.
 *
 * Before this slice, a generator declared INSIDE a function body always took
 * the JS-host buffer path (`__create_generator` etc.) — the native lowering
 * was only wired for top-level declarations (`collectDeclarations` /
 * `registerBodylessFunctionDeclaration`). So a nested generator in standalone
 * either leaked env imports or hit the late-import funcindex CE (#2079's class,
 * but for nested decls). The hoisted-to-top-level form of the SAME generator
 * worked.
 *
 * `compileNestedFunctionDeclaration` now, for a NO-CAPTURE native-generator
 * candidate, registers it via `registerNativeGenerator` (state-struct return)
 * and emits the factory via `compileNativeGeneratorFunction` — exactly the
 * top-level path. A *capturing* nested generator still falls through to the
 * host path (its captured cells would need to spill into the state struct — a
 * separate, larger change; tracked as the SF-1 capture follow-up).
 *
 * Every case must compile standalone with ZERO host imports and run correctly.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2172 no-capture nested native generator", () => {
  it("sequential yields, nested in a function body", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* g(){ yield 1; yield 2; yield 3; }
        let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(6);
  });

  it("while-loop yield, nested", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* g(){ let i = 0; while (i < 4) { yield i; i++; } }
        let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(6); // 0+1+2+3
  });

  it("for-loop yield with a param bound, nested", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* g(n: number){ for (let i = 0; i < n; i++) yield i * 2; }
        let s = 0; for (const v of g(4)) s += v; return s; }`),
    ).toBe(12); // 0+2+4+6
  });

  it("manual next().value, nested", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* g(){ yield 7; yield 8; }
        const it = g(); return it.next().value as number; }`),
    ).toBe(7);
  });

  it("two distinct nested generators in one function", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* a(){ yield 1; yield 2; }
        function* b(){ yield 3; yield 3; }
        let s = 0; for (const v of a()) s += v; for (const v of b()) s += v; return s; }`),
    ).toBe(9); // (1+2) + (3+3)
  });
});

describe("#2172 regression — top-level native generators unchanged", () => {
  it("top-level sequential for-of", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(6);
  });

  it("top-level while-loop yield", async () => {
    expect(
      await runStandalone(`function* g(){ let i = 0; while (i < 4) { yield i; i++; } }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(6);
  });
});
