// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2903 R4b — standalone TypedArray typed-RESULT callback HOFs (`map`/`filter`).
//
// R4 landed the SCALAR HOFs (find/forEach/some/every/reduce) via the generic
// `__hof_*` loop. `map`/`filter` differ: they must return a NEW TypedArray of
// the SAME element kind, so the result needs a freshly-allocated packed
// `$__vec_<kind>` carrier with per-element width-wrapping — which the generic
// $ObjVec-returning loop cannot produce. On main these leaked
// `env.__make_callback` (host-free instantiation failed) and returned nothing.
//
// Fix (src/codegen/ta-hof-map-filter.ts + calls.ts interception, standalone-
// gated → gc/wasi byte-identical): `__ta_map_<kind>`/`__ta_filter_<kind>`
// allocate the result carrier and drive the callback host-free via
// `__apply_closure`; the value is stored with `i32.trunc_sat_f64_s` + a packed
// `array.set` (JS ToInt8/ToUint8/… width-wrapping). `filter` is single-pass
// (predicate runs once per element) and sets the result LENGTH field to the kept
// count over an over-allocated backing array.
//
// SCOPE: the six PACKED-INTEGER views (Int8/Uint8/Int16/Uint16/Int32/Uint32).
// `Uint8ClampedArray` (needs round-half-to-even clamping) and the `any`-held
// receiver (runtime carrier-kind dispatch) are deferred follow-ups; Float32/
// Float64Array already map/filter correctly through the f64 path.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  expect((result.imports ?? []).map((i) => i.name)).toEqual([]); // host-free
  const { instance } = await WebAssembly.instantiate(result.binary!, {}); // zero imports
  return (instance.exports as { test(): number }).test();
}

describe("#2903 R4b — standalone TypedArray map/filter are native + host-free", () => {
  it("Uint8Array.map applies the callback", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([1, 2, 3]); const b = a.map((x: number) => x * 2); return b[0] + b[1] + b[2]; }`,
      ),
    ).toBe(12);
  });

  it("Uint8Array.map wraps results to the element width (300 → 44)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([100, 200, 50]); const b = a.map((x: number) => x + 100); return b[1]; }`,
      ),
    ).toBe(44);
  });

  it("Uint8Array.map passes the index as the second callback arg", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([10, 20, 30]); const b = a.map((x: number, i: number) => x + i); return b[0] + b[1] + b[2]; }`,
      ),
    ).toBe(63);
  });

  it("Uint8Array.filter keeps matching elements (length + values)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([5, 2, 8, 1, 9]); const b = a.filter((x: number) => x >= 5); return b.length * 1000 + b[0] * 100 + b[1] * 10 + b[2]; }`,
      ),
    ).toBe(3589);
  });

  it("Uint8Array.filter empty result has length 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([1, 2, 3]); const b = a.filter((x: number) => x > 100); return b.length; }`,
      ),
    ).toBe(0);
  });

  it("Int8Array.map preserves signed values (static read)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Int8Array([1, 2, 3]); const b = a.map((x: number) => x - 10); return b[0]; }`,
      ),
    ).toBe(-9);
  });

  it("Int16Array.map / Uint16Array.map wrap-around", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Int16Array([1000, 2000]); const b = a.map((x: number) => x + 100); const c = new Uint16Array([65535]); const d = c.map((x: number) => x + 2); return b[0] + b[1] + d[0]; }`,
      ),
    ).toBe(3200 + 1);
  });

  it("Int32Array.map handles full 32-bit + negatives", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Int32Array([100000, -5]); const b = a.map((x: number) => x * 2); return b[0] + b[1]; }`,
      ),
    ).toBe(199990);
  });

  it("map result is a real TypedArray (chains into a scalar HOF)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([1, 2, 3]); return a.map((x: number) => x * 2).reduce((s: number, x: number) => s + x, 0); }`,
      ),
    ).toBe(12);
  });

  it("untyped (test262-shape) Uint8Array.map is host-free", async () => {
    expect(
      await runStandalone(
        `function test() { var a = new Uint8Array([1, 2, 3]); var b = a.map(function (x) { return x + 1; }); return b[0] + b[1] + b[2]; }\nexport { test };`,
      ),
    ).toBe(9);
  });
});
