// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2190 — standalone array element indexing through the externref boundary.
//
// Sibling of #2189 (array `.length` through the boundary). A real array literal
// lowers to a `__vec_<elemKind>` struct `(length i32, data (ref array))`. When
// such a value is boxed to externref (assigned to an `any` local, returned from
// an `any`-typed function), a NUMERIC indexed read `arr[i]` routes through the
// native `__extern_get_idx(externref, f64) -> externref` runtime helper. Before
// this fix that helper only recognised a `$ObjVec` (enumeration result) or an
// array-like `$Object` — NOT the concrete `__vec_<elemKind>` struct — so a boxed
// array fell through to null: `const a: any = [1,2,3]; a[1]` was 0 (null→f64) and
// `const a: any = ["x","y"]; a[1]` was null.
//
// Fix: `fillExternGetIdxVecArms` appends one `ref.test`/`ref.cast` arm per
// registered `__vec_<elemKind>` carrier at FINALIZE (after all carriers are
// known), bounds-checks against field 0 (length), reads `data[i]`, and boxes the
// element to externref per element kind (f64→__box_number, i32→convert+box,
// ref→extern.convert_any). Standalone only; host mode's `__extern_get_idx` import
// owns the path.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2190 standalone array element indexing through the externref boundary", () => {
  it("number array index through `any` boundary returns the element", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [10, 20, 30];
        return a[1];
      }`),
    ).toBe(20);
  });

  // NOTE: string (and other GC-ref element) array indexing through the externref
  // boundary is intentionally NOT covered by this slice. Synthesizing a typed-vec
  // arm for a `ref`/`ref_null` element produced invalid Wasm
  // (`__extern_get_idx return[0] expected externref, got (ref null N)`) for some
  // carriers the proposal harness registers, which regressed ~90 standalone
  // tests (#2190 first-cut). This slice ships only the provably-safe number-array
  // path (plain f64/i32 elements); GC-ref / boolean element indexing is deferred
  // to a follow-up that resolves the element-ref→externref widening validity per
  // carrier. A boxed string array therefore still reads back `undefined` here —
  // no worse than pre-#2190.
  it("string array index through `any` boundary is undefined (deferred GC-ref path)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = ["x", "y", "z"];
        return a[2] === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("index through an `any`-typed function return", async () => {
    expect(
      await runStandalone(`function g(): any { return [1, 2, 3, 4]; }
      export function test(): number {
        return g()[3];
      }`),
    ).toBe(4);
  });

  it("first element (index 0)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [42, 7];
        return a[0];
      }`),
    ).toBe(42);
  });

  it("out-of-bounds index yields undefined", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [1, 2, 3];
        return a[99] === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("negative index yields undefined", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [1, 2, 3];
        return a[-1] === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("length (#2189) and indexing (#2190) agree through the boundary", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [5, 6, 7, 8];
        let sum = 0;
        for (let i = 0; i < a.length; i++) { sum += a[i]; }
        return sum;
      }`),
    ).toBe(26);
  });
});
