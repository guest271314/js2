// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3133 — `.constructor` on plain-object / array receivers resolves to the
 * SAME identity-stable namespace-object singleton the bare `Object` / `Array`
 * identifier reads (standalone).
 *
 * #3006 gave the Set/Map/Weak* family genuine reified constructor identity but
 * deliberately EXCLUDED `Object`/`Array` ("already carry a genuine bare-value
 * identity — namespace objects"). True for the bare value — but the
 * `.constructor` READ path for their instances was never routed anywhere, so
 * `({}).constructor` / `[1].constructor` / `Object.prototype.constructor` /
 * `Array.prototype.constructor` fell through to the dynamic `$Object` own-prop
 * read and returned `undefined`. The fix routes those reads to the per-name
 * `__builtin_<Name>` global, so identity is GENUINELY true (same WasmGC object)
 * and the swap-wrong-builtin cross-check is GENUINELY false (distinct
 * singletons) — not a null≡null / undefined≡undefined tautology (memory
 * `project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous`).
 */

async function runStandalone(src: string): Promise<{ value: unknown; hostImports: string[] }> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const hostImports = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => l.startsWith("env::"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const value = (instance.exports as { test: () => unknown }).test();
  return { value, hostImports };
}

describe("#3133 — plain-object/array .constructor identity (standalone)", () => {
  it("({}).constructor === Object (was false — read returned undefined)", async () => {
    const { value, hostImports } = await runStandalone(
      `export function test(): number { const o = {}; return o.constructor === Object ? 1 : 0; }`,
    );
    expect(value).toBe(1);
    expect(hostImports).toEqual([]);
  });

  it("[1].constructor === Array", async () => {
    const { value } = await runStandalone(
      `export function test(): number { const a = [1]; return a.constructor === Array ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("Object.prototype.constructor === Object (test262 S15.2.4.1_A1_T1 shape)", async () => {
    const { value } = await runStandalone(
      `export function test(): number { return Object.prototype.constructor === Object ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("Array.prototype.constructor === Array (test262 Array/prototype/constructor.js shape)", async () => {
    const { value } = await runStandalone(
      `export function test(): number { return Array.prototype.constructor === Array ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("swap-wrong-builtin guard: ({}).constructor === Array stays false", async () => {
    const { value } = await runStandalone(
      `export function test(): number { const o = {}; return (o.constructor as any) === Array ? 1 : 0; }`,
    );
    expect(value).toBe(0);
  });

  it("swap-wrong-builtin guard: [1].constructor === Object stays false", async () => {
    const { value } = await runStandalone(
      `export function test(): number { const a = [1]; return (a.constructor as any) === Object ? 1 : 0; }`,
    );
    expect(value).toBe(0);
  });

  it("identity survives the sameValue harness boundary (externref widening)", async () => {
    const { value } = await runStandalone(
      `function same(a: any, b: any): boolean { return a === b; }
export function test(): number { return same(Object.prototype.constructor, Object) ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("identity is per-instance stable: ({}).constructor === ({x:1}).constructor", async () => {
    const { value } = await runStandalone(
      `export function test(): number { const o = {}; const p = { x: 1 }; return o.constructor === p.constructor ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("user class instances keep their own constructor identity", async () => {
    const { value } = await runStandalone(
      `class A {}
export function test(): number { const a = new A(); return a.constructor === A ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("a user-declared { constructor: v } member keeps its own property read", async () => {
    const { value } = await runStandalone(
      `export function test(): number { const o = { constructor: 5 }; return (o.constructor as any) === 5 ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("type-literal annotation does not fold: const o: {} = new A()", async () => {
    const { value } = await runStandalone(
      `class A {}
export function test(): number { const o: {} = new A(); return (o.constructor as any) === Object ? 1 : 0; }`,
    );
    expect(value).toBe(0);
  });

  it("module that ASSIGNS a .constructor prop anywhere declines the fold", async () => {
    const { value } = await runStandalone(
      `export function test(): number { const q: any = {}; q.constructor = 3; const o = {}; return (o.constructor as any) === Object ? 1 : 0; }`,
    );
    expect(value).toBe(0);
  });

  it("#3006 Set-family constructor identity is untouched", async () => {
    const { value } = await runStandalone(
      `export function test(): number { return Set.prototype.constructor === Set ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("no new env:: host imports for the folded reads", async () => {
    const { hostImports } = await runStandalone(
      `export function test(): number { const a = [1]; const o = {}; return o.constructor === Object && a.constructor === Array ? 1 : 0; }`,
    );
    expect(hostImports).toEqual([]);
  });
});
