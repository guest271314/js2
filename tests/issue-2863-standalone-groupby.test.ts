// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2863 Phase 3 — standalone `Object.groupBy(array, callback)` no longer refuses.
//
// Under `--target standalone`/`wasi` there is no host `__object_groupBy`, so
// `Object.groupBy([...], fn)` hit the #1472 "dynamic-shape object/property
// operation is not supported" compile refusal. This slice adds a Wasm-native
// `__object_groupBy` helper (object-runtime.ts) for array / array-like receivers:
// it iterates via `__extern_length`/`__extern_get_idx`, invokes the callback
// through the open-`any` closure bridge `__apply_closure`, and groups the
// original elements into a null-prototype `$Object` of `$ObjVec` arrays keyed by
// ToPropertyKey(callback(value, index)) (ES2024 §20.1.2.14, keyCoercion PROPERTY).
//
// Generic iterables (Map/Set/user iterators) still refuse loudly — the native
// iterator carrier is the #2864 follow-up. Host (gc) mode keeps the
// `__object_groupBy` host import unchanged.
//
// String returns from a standalone module are native-string refs; these assert
// via numeric exports (group `.length`, element values) — never a JS string.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // A standalone module must not leak any host import (e.g. __object_groupBy or
  // __make_callback from the callback lowering).
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2863 Phase 3 — standalone Object.groupBy (array receiver)", () => {
  it("groups by even/odd string key — correct group sizes (was a compile refusal)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const g: any = Object.groupBy([1, 2, 3, 4, 5, 6], (x: number) => (x % 2 === 0 ? "even" : "odd"));
           return g.even.length;
         }`,
      ),
    ).toBe(3);
  });

  it("preserves the original element values in group order", async () => {
    // g.k === [10, 20, 30]; g.k[1] === 20
    expect(
      await runStandalone(
        `export function test(): number {
           const g: any = Object.groupBy([10, 20, 30], (_x: number) => "k");
           return g.k[1];
         }`,
      ),
    ).toBe(20);
  });

  it("passes the index as the second callback argument", async () => {
    // first two → "lo", last two → "hi"; lo.length + hi.length*10 === 2 + 2*10
    expect(
      await runStandalone(
        `export function test(): number {
           const g: any = Object.groupBy([5, 5, 5, 5], (_x: number, i: number) => (i < 2 ? "lo" : "hi"));
           return g.lo.length + g.hi.length * 10;
         }`,
      ),
    ).toBe(22);
  });

  it('ToPropertyKeys a numeric callback result (0/1 → "0"/"1")', async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const g: any = Object.groupBy([1, 2, 3, 4], (x: number) => x % 2);
           return g["0"].length + g["1"].length * 10;
         }`,
      ),
    ).toBe(22);
  });

  it("empty array → empty grouping object (callback never called)", async () => {
    // g has no own key "k" → g.k is undefined → return -1
    expect(
      await runStandalone(
        `export function test(): number {
           const g: any = Object.groupBy([] as number[], (_x: number) => "k");
           return g.k === undefined ? -1 : g.k.length;
         }`,
      ),
    ).toBe(-1);
  });

  it("single group collects every element", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const g: any = Object.groupBy([1, 2, 3], (_x: number) => "same");
           return g.same.length;
         }`,
      ),
    ).toBe(3);
  });
});

describe("#2863 Phase 3 — non-array iterables still refuse (fail-loud, #2864 follow-up)", () => {
  it("a Map receiver is refused loudly, not silently mis-grouped", async () => {
    const r = await compile(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(1, 2);
         const g: any = Object.groupBy(m, (_x: any) => "k");
         return 0;
       }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect((r.errors ?? []).some((e) => /__object_groupBy/.test(String(e.message)))).toBe(true);
  });
});

describe("#2863 Phase 3 — host (gc) mode is unchanged", () => {
  it("host mode keeps the __object_groupBy import (native JS Object.groupBy)", async () => {
    const r = await compile(
      `export function test(): number {
         const g: any = Object.groupBy([1, 2, 3, 4], (x: number) => (x % 2 === 0 ? "even" : "odd"));
         return g.even.length;
       }`,
      {},
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).some((i) => i.name === "__object_groupBy")).toBe(true);
  });
});
