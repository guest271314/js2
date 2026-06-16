// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1988 — `any + any` (and `any + number`) with an object/array operand must
// apply §13.15.3 ApplyStringOrNumericBinaryOperator: ToPrimitive(default) on
// both operands, then if either is a String → string CONCATENATION, else
// numeric add. A plain object's ToPrimitive→toString is "[object Object]", so
// `1 + {}` is "1[object Object]", not NaN.
//
// JS-host mode delegates `+` to `__host_add` (JS `+`) and was already correct.
// The regression lived in the standalone / pure-WasmGC path: `__any_add`
// (tagged-union helper) and `emitAnyAdd` (externref helper) only had i32/f64
// arms, so a tag-5 (string) or tag-6 (object/array ref) operand wrongly hit the
// numeric arm → NaN. The fix routes ToPrimitive-string operands through native
// string concatenation (`__extern_toString` + `__str_concat`).
//
// Standalone assertions read the concat result back through a `string`-typed
// return (`(a + b) as string`) and check `.length`, which exercises the native
// `$AnyValue` tag-5 → `$AnyString` unbox (also fixed here: it read `refval`
// instead of `externval`). Comparing the `any` result directly against a string
// literal is intentionally avoided — `any === stringLiteral` content comparison
// is a separate, still-open gap (tracked elsewhere) and would confound this
// test. Array-element joins (`[1,2] + 1` → "1,21") in standalone depend on the
// array-toString-via-join path (#1997/#1998) and are out of scope here.
import { describe, expect, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("#1988 any + ref operand applies ToPrimitive (JS-host / default mode)", () => {
  it("1 + {} → ToString concatenation", async () => {
    await assertEquivalent(`export function f(o: any): any { return 1 + o; }`, [{ fn: "f", args: [{}] }]);
  });

  it("{} + 1 → ToString concatenation", async () => {
    await assertEquivalent(`export function f(o: any): any { return o + 1; }`, [{ fn: "f", args: [{}] }]);
  });

  it('{} + {} → "[object Object][object Object]"', async () => {
    await assertEquivalent(`export function f(a: any, b: any): any { return a + b; }`, [{ fn: "f", args: [{}, {}] }]);
  });

  it("[] + [] → empty string", async () => {
    await assertEquivalent(`export function f(a: any, b: any): any { return a + b; }`, [{ fn: "f", args: [[], []] }]);
  });

  it('[1,2] + 1 → "1,21"', async () => {
    await assertEquivalent(`export function f(a: any, b: any): any { return a + b; }`, [
      { fn: "f", args: [[1, 2], 1] },
    ]);
  });

  it("both numbers stay numeric (no false concat)", async () => {
    await assertEquivalent(`export function f(a: any, b: any): any { return a + b; }`, [{ fn: "f", args: [40, 2] }]);
  });
});

describe("#1988 any + ref operand applies ToPrimitive (standalone / pure WasmGC)", () => {
  async function compileStandalone(s: string) {
    const r = await compile(s, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    return r;
  }

  // The `+` result is read as a native string; `.length` confirms the concat
  // produced the right characters without depending on the (separately-broken)
  // any-vs-literal string comparison.
  async function concatLen(body: string): Promise<number> {
    const src = `export function f(a: any, b: any): string { return (a + b) as string; }
                 export function test(): number { ${body} }`;
    const r = await compileStandalone(src);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    (r.importObject as unknown as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
    return (instance.exports as Record<string, () => number>).test();
  }

  it('1 + {} length is 16 ("1[object Object]")', async () => {
    expect(await concatLen(`const o: any = {}; return f(1, o).length;`)).toBe(16);
  });

  it('{} + {} length is 30 (two "[object Object]")', async () => {
    expect(await concatLen(`const o: any = {}; return f(o, o).length;`)).toBe(30);
  });

  it("string + string any concatenates (length 2)", async () => {
    expect(await concatLen(`const a: any = "a"; const b: any = "b"; return f(a, b).length;`)).toBe(2);
  });

  it("does not leak a JS host import", async () => {
    const r = await compileStandalone(`export function f(a: any, b: any): any { return a + b; }`);
    expect(r.imports.length).toBe(0);
  });
});
