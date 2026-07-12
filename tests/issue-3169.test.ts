// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3169 — standalone: Array.prototype callback HOFs (reduce/reduceRight/filter/
// some/every/map/forEach) over ARRAY-LIKE receivers via `.call`.
//
// Root cause (measured, 2026-07-12 lane diff — ~519 gap tests): the dominant
// test262 receiver shape `var obj = { 0: 11, 1: 12, length: 2 }` has NO
// contextual type, so it compiles to a CLOSED nominal WasmGC struct
// (`$__anon_N` with fields `$0/$1/$length`), NOT an open `$Object` (#1897).
// The standalone dynamic-reader trio (`__extern_length` / `__extern_get_idx` /
// `__extern_has_idx`) had arms for `$Object`/`$ObjVec`/typed vecs only, so a
// closed-struct receiver answered `length 0` — the generic
// `compileArrayLikePrototypeCall` loop ran ZERO iterations and returned the
// seed ("returned 2 — assert #1").
//
// Fix (three coupled pieces, all standalone-gated — gc/host byte-identical):
//  1. object-runtime.ts `fillExternArrayLikeStructArms` (finalize): splice one
//     `ref.test`-guarded CLOSED-STRUCT arm per array-like struct (a numeric-able
//     `length` field) into each of the three readers — `struct.get $length` +
//     ToLength clamp; per-canonical-integer-field `f64.eq` index reads (+ box);
//     HasProperty OR-chain (hole semantics: `{0:x, 2:y, length:3}` skips 1).
//  2. array-methods.ts: retire the standalone `reduce`/`reduceRight`
//     NO-INITIAL-VALUE refusal — the M2.2c funcidx-shift bug it guarded is gone
//     (the loop re-resolves `__extern_has_idx`/`__extern_get_idx`/`__is_truthy`
//     BY NAME after the receiver+callback compile, the #16 discipline). The
//     §23.1.3.24 step-6 hole-scan seed now compiles natively.
//  3. property-access.ts: standalone twin of the #2773 dynamic-`any`-index arm
//     (host/gc-only before) — `obj[idx]` inside a named-function HOF callback
//     (implicit-`any` idx) unboxes the key and routes numeric keys through the
//     positional `__extern_get_idx` (vecs, `$ObjVec`, `$Object`, and the new
//     closed-struct arms); genuine string keys keep the old `__extern_get`.
//
// The standalone assertions instantiate with an EMPTY import object and first
// assert the module declares ZERO imports — the behaviour is truly HOST-FREE.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile host-free (`target: standalone`), assert 0 imports, run test(). */
async function runStandaloneHostFree(source: string): Promise<unknown> {
  const result: any = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const mod = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(mod);
  expect(imports.map((i) => `${i.module}.${i.name}`)).toEqual([]);
  const instance: any = await WebAssembly.instantiate(mod, {});
  return instance.exports.test();
}

describe("#3169 — Array.prototype HOFs over closed-struct array-like receivers (.call, standalone host-free)", () => {
  it("reduce.call with initial value over a typed array-like literal (was: returned the seed)", async () => {
    expect(
      await runStandaloneHostFree(`
        var obj = { 0: 11, 1: 12, length: 2 };
        export function test(): number {
          var r: any = Array.prototype.reduce.call(obj, (acc: any, v: any) => acc + v, 1);
          return r === 24 ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("reduce.call with a NAMED function callback (the dominant test262 shape)", async () => {
    expect(
      await runStandaloneHostFree(`
        var accessed = false;
        function callbackfn(prevVal: any, curVal: any, idx: any, obj: any) {
          accessed = true;
          return curVal > 10;
        }
        var obj = { 0: 11, 1: 12, length: 2 };
        export function test(): number {
          var r: any = Array.prototype.reduce.call(obj, callbackfn, 1);
          return r === true && accessed ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("reduce.call with NO initial value seeds from the first element (was: standalone refusal)", async () => {
    expect(
      await runStandaloneHostFree(`
        var obj = { 0: 11, 1: 12, length: 2 };
        export function test(): number {
          var r: any = Array.prototype.reduce.call(obj, (acc: any, v: any) => acc + v);
          return r === 23 ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("reduce.call no-init skips a hole at index 0 when seeding (§23.1.3.24 step 6.b)", async () => {
    expect(
      await runStandaloneHostFree(`
        var obj = { 1: 40, 2: 2, length: 3 };
        export function test(): number {
          var r: any = Array.prototype.reduce.call(obj, (acc: any, v: any) => acc + v);
          return r === 42 ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("reduce.call skips holes mid-walk (HasProperty gate: {0, 2, length: 3})", async () => {
    expect(
      await runStandaloneHostFree(`
        function callbackfn(prevVal: any, curVal: any, idx: any, obj: any) { return prevVal + curVal; }
        var obj = { 0: 11, 2: 12, length: 3 };
        export function test(): number {
          var r: any = Array.prototype.reduce.call(obj, callbackfn, 0);
          return r === 23 ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("reduceRight.call walks backwards over the array-like", async () => {
    expect(
      await runStandaloneHostFree(`
        var order = "";
        function callbackfn(prevVal: any, curVal: any) { order = order + curVal; return prevVal; }
        var obj = { 0: 1, 1: 2, 2: 3, length: 3 };
        export function test(): number {
          Array.prototype.reduceRight.call(obj, callbackfn, 0);
          return order === "321" ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("map.call produces an indexable result over the array-like", async () => {
    expect(
      await runStandaloneHostFree(`
        function callbackfn(val: any, idx: any, obj: any) { return val * 2; }
        var obj = { 0: 5, 1: 6, length: 2 };
        export function test(): number {
          var r: any = Array.prototype.map.call(obj, callbackfn);
          return r[1] === 12 ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("filter.call keeps only matching elements", async () => {
    expect(
      await runStandaloneHostFree(`
        var obj = { 0: 5, 1: 60, 2: 7, length: 3 };
        export function test(): number {
          var r: any = Array.prototype.filter.call(obj, (v: any) => v < 10);
          return r.length === 2 ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("every.call / some.call over the array-like", async () => {
    expect(
      await runStandaloneHostFree(`
        var obj = { 0: 5, 1: 6, length: 2 };
        export function test(): number {
          var e: any = Array.prototype.every.call(obj, (v: any) => v > 4);
          var s: any = Array.prototype.some.call(obj, (v: any) => v > 5);
          var n: any = Array.prototype.some.call(obj, (v: any) => v > 6);
          return e === true && s === true && n === false ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("forEach.call visits each present element", async () => {
    expect(
      await runStandaloneHostFree(`
        var sum = 0;
        function callbackfn(val: any) { sum += val; }
        var obj = { 0: 5, 1: 6, 3: 100, length: 3 };
        export function test(): number {
          Array.prototype.forEach.call(obj, callbackfn);
          return sum === 11 ? 1 : -1; // index 2 is a hole; index 3 is past length
        }`),
    ).toBe(1);
  });

  it("length is ToLength-clamped: fractional length truncates", async () => {
    expect(
      await runStandaloneHostFree(`
        var obj = { 0: 1, 1: 2, 2: 3, length: 2.5 };
        export function test(): number {
          var r: any = Array.prototype.reduce.call(obj, (acc: any, v: any) => acc + v, 0);
          return r === 3 ? 1 : -1; // trunc(2.5) = 2 → visits 0,1 only
        }`),
    ).toBe(1);
  });

  it("every.call over an all-holes array-like ({length: 3}) answers true vacuously", async () => {
    expect(
      await runStandaloneHostFree(`
        var obj = { length: 3 };
        export function test(): number {
          var r: any = Array.prototype.every.call(obj, (v: any) => false);
          return r === true ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("callback reads obj[idx] with the implicit-any idx param (the -c-ii family)", async () => {
    expect(
      await runStandaloneHostFree(`
        var ok = true;
        function callbackfn(val: any, idx: any, obj: any) {
          if (obj[idx] !== val) ok = false;
        }
        var srcArr: any[] = [7, 8, "five"];
        export function test(): number {
          srcArr.map(callbackfn);
          return ok ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("callback obj[idx] reads work over the closed-struct array-like receiver too", async () => {
    expect(
      await runStandaloneHostFree(`
        var ok = true;
        function callbackfn(val: any, idx: any, obj: any) {
          if (obj[idx] !== val) ok = false;
        }
        var obj = { 0: 11, 1: 12, length: 2 };
        export function test(): number {
          Array.prototype.forEach.call(obj, callbackfn);
          return ok ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("dynamic STRING keys on an open object keep the string-keyed read path", async () => {
    expect(
      await runStandaloneHostFree(`
        export function test(): number {
          var o: any = { a: 5 };
          var k: any = "a";
          return o[k] === 5 ? 1 : -1;
        }`),
    ).toBe(1);
  });

  it("map.call over an ANY-typed ($Object) receiver still works (pre-#3169 behaviour preserved)", async () => {
    expect(
      await runStandaloneHostFree(`
        export function test(): number {
          const obj: any = { 0: 5, 1: 6, length: 2 };
          const r: any = Array.prototype.map.call(obj, (v: any) => v * 2);
          return r[0] === 10 && r[1] === 12 ? 1 : -1;
        }`),
    ).toBe(1);
  });
});
