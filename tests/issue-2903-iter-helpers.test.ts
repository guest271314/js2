// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2903 (sub-front 2) — standalone eager Iterator.prototype helpers
 * (find/every/some/forEach/reduce/toArray, ES2025 §27.1.4) on DYNAMIC
 * (`any`/externref) iterator receivers, host-free.
 *
 * Before this slice a generator receiver matched no arm in
 * `__call_m_<name>_<arity>` and fell to `__extern_method_call`'s
 * non-`$Object` arm → silent `undefined`; routing one into the generic
 * `__iterator` ladder instead trapped `illegal cast` (a DRIVEN native sync
 * generator has no ladder arm — for-of resumes it statically). The fix is
 * the `__iter_hof_*` stepped loops + positive-admission `__iter_hof_open`
 * classifier (iter-hof-native.ts). Every test asserts ZERO env imports and
 * host-free instantiation (`WebAssembly.instantiate(binary, {})`).
 */

async function runStandalone(src: string): Promise<{ value: unknown; envImports: string[] }> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  if (!r.success) throw new Error("unreachable");
  const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const value = (instance.exports as { test: () => unknown }).test();
  return { value, envImports };
}

describe("#2903 — eager Iterator helpers on generator receivers (standalone, host-free)", { timeout: 30000 }, () => {
  it("find returns the first predicate hit", async () => {
    const { value, envImports } = await runStandalone(`
      function* g(): any { yield 1; yield 2; yield 3; }
      export function test(): number {
        const found: any = (g() as any).find(function (v: any) { return v === 2; });
        return found === 2 ? 1 : 0;
      }`);
    expect(value).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("find misses → undefined; predicate sees (value, counter)", async () => {
    // Counter observed numerically — `str += boxedArg` inside a HOF callback
    // is a PRE-EXISTING standalone trap on main (array receivers too).
    const { value } = await runStandalone(`
      function* g(): any { yield 10; yield 20; }
      export function test(): number {
        let sum = 0;
        const found: any = (g() as any).find(function (v: any, i: any) { sum = sum * 10 + i; return false; });
        return (found === undefined && sum === 1) ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("every short-circuits on the first falsy result", async () => {
    const { value } = await runStandalone(`
      function* g(): any { yield 1; yield 0; yield 2; }
      export function test(): number {
        let calls = 0;
        const r: any = (g() as any).every(function (v: any) { calls += 1; return v > 0; });
        return (r === false && calls === 2) ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("every over an all-truthy generator is true", async () => {
    const { value } = await runStandalone(`
      function* g(): any { yield 1; yield 2; }
      export function test(): number {
        return ((g() as any).every(function (v: any) { return v > 0; }) === true) ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("some short-circuits true; exhausted some is false", async () => {
    const { value } = await runStandalone(`
      function* g(): any { yield 1; yield 5; yield 1; }
      export function test(): number {
        let calls = 0;
        const hit: any = (g() as any).some(function (v: any) { calls += 1; return v === 5; });
        const miss: any = (g() as any).some(function (v: any) { return v === 9; });
        return (hit === true && calls === 2 && miss === false) ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("forEach visits every value and returns undefined", async () => {
    const { value } = await runStandalone(`
      function* g(): any { yield 3; yield 4; }
      export function test(): number {
        let sum = 0;
        const r: any = (g() as any).forEach(function (v: any) { sum += v; });
        return (sum === 7 && r === undefined) ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("reduce with an initial value", async () => {
    const { value } = await runStandalone(`
      function* g(): any { yield 1; yield 2; yield 3; }
      export function test(): number {
        return ((g() as any).reduce(function (a: any, v: any) { return a + v; }, 10) === 16) ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("reduce with no initial value seeds from the first step (counter starts at 1)", async () => {
    const { value } = await runStandalone(`
      function* g(): any { yield 5; yield 2; yield 3; }
      export function test(): number {
        let firstCounter = -1;
        const r: any = (g() as any).reduce(function (a: any, v: any, i: any) {
          if (firstCounter === -1) firstCounter = i;
          return a + v;
        });
        return (r === 10 && firstCounter === 1) ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("toArray drains the generator into an indexable array", async () => {
    const { value } = await runStandalone(`
      function* g(): any { yield 7; yield 8; }
      export function test(): number {
        const arr: any = (g() as any).toArray();
        return (arr.length === 2 && arr[0] === 7 && arr[1] === 8) ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });
});

describe("#2903 — admission guards (no trap, no behavior change for non-iterators)", { timeout: 30000 }, () => {
  it("GUARD: class-instance receiver answers the legacy undefined (was a trap risk)", async () => {
    const { value } = await runStandalone(`
      class C { y: number = 2; }
      export function test(): number {
        const o: any = new C();
        const r: any = o.find(function (_v: any) { return true; });
        return r === undefined ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("GUARD: string receiver answers the legacy undefined", async () => {
    const { value } = await runStandalone(`
      export function test(): number {
        const s: any = "abc";
        const r: any = s.reduce(function (a: any, _v: any) { return a; }, 0);
        return r === undefined ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });

  it("GUARD: array receivers stay on the native vec HOF arm (#3098)", async () => {
    const { value, envImports } = await runStandalone(`
      export function test(): number {
        const a: any = [3, 4, 5];
        const f: any = a.find(function (v: any) { return v > 3; });
        const r: any = a.reduce(function (x: any, y: any) { return x + y; }, 0);
        return (f === 4 && r === 12) ? 1 : 0;
      }`);
    expect(value).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("GUARD: a user object-literal { find(){…} } method still wins over the iterator arm", async () => {
    // Method shorthand → a closed-struct method arm (the field-stored
    // `find: function` form answers 0 on main already — pre-existing #3117
    // marshaling gap, not this slice's concern).
    const { value } = await runStandalone(`
      export function test(): number {
        const o: any = { find(x: any): number { return 42; } };
        return o.find(function (_v: any) { return true; }) === 42 ? 1 : 0;
      }`);
    expect(value).toBe(1);
  });
});
