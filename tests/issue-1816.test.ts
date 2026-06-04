// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1816 — `Array.prototype.sort` must honor a user comparator.
 *
 * Residual of #1361: the sort path called `ensureTimsortHelper`, which hard-codes
 * numeric `i32.lt_s`/`f64.lt` and ignored any `comparefn`, so
 * `[3,1,2].sort((a,b)=>b-a)` returned `[1,2,3]`. The fix routes comparator sorts
 * through a stable insertion sort that invokes the comparator closure via
 * `call_ref` and uses the spec ordering `comparator(a,b) > 0 ⇒ a after b`
 * (§23.1.3.30 / SortIndexedProperties / CompareArrayElements).
 *
 * These tests assert the resulting *order* (the prior test only asserted
 * "doesn't throw", which masked the bug). The no-arg default sort remains the
 * existing numeric Timsort (the default-ToString half is tracked separately).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runExport(source: string, fn: string): Promise<number> {
  const result = await compile(source, { fileName: "t.js", target: "wasi", nativeStrings: true });
  expect(result.success, `Compile failed: ${result.errors?.map((e) => e.message).join("; ")}`).toBe(true);
  // Provide a no-op stub for every host import (some array shapes pull one in).
  const imports: Record<string, Record<string, () => number>> = {
    wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) as Record<string, () => number>,
  };
  for (const imp of result.imports ?? []) {
    imports[imp.module] ??= {};
    imports[imp.module]![imp.name] = () => 0;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports[fn] as () => number)();
}

describe("#1816 — Array.prototype.sort honors the comparator", () => {
  it("descending comparator (b - a) reverses ascending input", async () => {
    // [3,1,2].sort((x,y)=>y-x) === [3,2,1] → packed 321
    expect(
      await runExport(
        `export function test(){ const a=[3,1,2]; a.sort((x,y)=>y-x); return a[0]*100+a[1]*10+a[2]; }`,
        "test",
      ),
    ).toBe(321);
  });

  it("ascending comparator (a - b) sorts ascending", async () => {
    expect(
      await runExport(
        `export function test(){ const a=[3,1,2]; a.sort((x,y)=>x-y); return a[0]*100+a[1]*10+a[2]; }`,
        "test",
      ),
    ).toBe(123);
  });

  it("descending comparator over a larger array", async () => {
    // [5,3,8,1,9,2,7] desc → [9,8,7,5,3,2,1]
    expect(
      await runExport(
        `export function test(){
           const a=[5,3,8,1,9,2,7]; a.sort((x,y)=>y-x);
           return (a[0]===9 && a[1]===8 && a[2]===7 && a[3]===5 && a[4]===3 && a[5]===2 && a[6]===1) ? 1 : 0;
         }`,
        "test",
      ),
    ).toBe(1);
  });

  it("f64 comparator sorts floats", async () => {
    expect(
      await runExport(
        `export function test(){
           const a=[3.5,1.5,2.5]; a.sort((x,y)=>y-x);
           return (a[0]>a[1] && a[1]>a[2]) ? 1 : 0;
         }`,
        "test",
      ),
    ).toBe(1);
  });

  it("named-function comparator is honored", async () => {
    expect(
      await runExport(
        `function cmp(x,y){ return y-x; }
         export function test(){ const a=[1,3,2]; a.sort(cmp); return a[0]*100+a[1]*10+a[2]; }`,
        "test",
      ),
    ).toBe(321);
  });

  it("sort is stable (equal comparator keys preserve input order)", async () => {
    // Sort 2-digit numbers by their tens digit; the ones digit preserves order.
    // [21,12,11,22] keyed by tens (2,1,1,2) → stable → [12,11,21,22].
    expect(
      await runExport(
        `export function test(){
           const a=[21,12,11,22];
           a.sort((x,y)=>(((x/10)|0)-((y/10)|0)));
           return a[0]*1000000 + a[1]*10000 + a[2]*100 + a[3];
         }`,
        "test",
      ),
    ).toBe(12_11_21_22);
  });

  it("sort returns the receiver array (in-place)", async () => {
    expect(
      await runExport(
        `export function test(){ const a=[3,1,2]; const b=a.sort((x,y)=>x-y); return (b===a) ? a[0] : -1; }`,
        "test",
      ),
    ).toBe(1);
  });

  it("single-element and equal-element arrays are unchanged", async () => {
    expect(await runExport(`export function test(){ const a=[7]; a.sort((x,y)=>x-y); return a[0]; }`, "test")).toBe(7);
    expect(
      await runExport(`export function test(){ const a=[5,5,5]; a.sort((x,y)=>x-y); return a[0]+a[1]+a[2]; }`, "test"),
    ).toBe(15);
  });

  it("default no-arg sort still works (numeric Timsort, unchanged)", async () => {
    // The default-ToString half is tracked separately; the numeric default path
    // must remain intact for arrays sorted without a comparator.
    expect(
      await runExport(`export function test(){ const a=[3,1,2]; a.sort(); return a[0]*100+a[1]*10+a[2]; }`, "test"),
    ).toBe(123);
  });
});
