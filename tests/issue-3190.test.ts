// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3190 — standalone: dynamic STORE to an any-typed array element.
 *
 * The write-side sibling of #3183. A computed store `(arr as any)[i] = v` on an
 * any-typed receiver lowers to `__extern_set(obj, box(i), box(v))`. A real array
 * is a `__vec_<elemKind>` struct subtyping `$__vec_base` (#2186), NOT a
 * `$Object`, so `__extern_set`'s `ref.test $Object` missed it and the store was
 * silently dropped — the element was never written.
 *
 * `fillExternSetVecArms` (object-runtime.ts) splices a `$__vec_base` write arm
 * into `__extern_set`: index via `__unbox_number(key)`, bounds-check through
 * `$__vec_base`, then per-carrier `array.set(data, i, unbox(value))` with
 * per-kind UNBOXING (`unboxExternrefToVecElement`, the inverse of the read fill's
 * `boxVecElementToExternref`). Standalone-only; host output byte-identical.
 *
 * SCOPE: the IN-BOUNDS OVERWRITE half. Growth (`a[len] = v`, `new Array()` +
 * writes) needs the resizable-vec representation and is deferred (#3190 note).
 *
 * Writes are OBSERVED here via NUMERIC index reads (`a[i]`), which are vec-aware
 * since #2190 and independent of the #3183 for-in / string-key READ fill. Every
 * case compiles standalone and must instantiate with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandaloneNum(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3190 — standalone dynamic STORE to an any-typed array element", () => {
  it("in-bounds overwrite lands (number[] carrier)", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var a: any = [0, 0, 0];
        a[1] = 42;
        return a[1];
      }`),
    ).toBe(42);
  });

  it("overwrite every element then sum", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var a: any = [0, 0, 0];
        a[0] = 1; a[1] = 2; a[2] = 3;
        return a[0] + a[1] + a[2];
      }`),
    ).toBe(6);
  });

  it("index sourced from an any-typed variable", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var a: any = [0, 0];
        var i: any = 1;
        a[i] = 77;
        return a[1];
      }`),
    ).toBe(77);
  });

  it("non-integer value coerces to the carrier element type", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var a: any = [0];
        a[0] = 3.5;
        return (a[0] as number) * 2;
      }`),
    ).toBe(7);
  });

  it("externref (any[]) carrier store lands", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var a: any = [1, 2, 3];
        var b: any = a;
        b[0] = 9;
        return b[0];
      }`),
    ).toBe(9);
  });

  it("out-of-bounds store is a silent no-op (no trap, existing data intact)", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var a: any = [7];
        a[5] = 99;
        return a[0];
      }`),
    ).toBe(7);
  });

  it("negative-index store is a silent no-op (no trap)", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var a: any = [7];
        a[-1] = 99;
        return a[0];
      }`),
    ).toBe(7);
  });

  it("regression guard: plain any-typed object element store is unchanged", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var o: any = {};
        o["x"] = 5;
        return o["x"];
      }`),
    ).toBe(5);
  });
});
