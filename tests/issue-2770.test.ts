import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #2770 (S5b of #2773) — a boolean-returning builtin method on a BARE-`var`
// (evolving-`any` / dynamic) receiver dispatched through the
// `${className}_${methodName}` funcMap path returned a bare i32 with the
// `boolean: true` brand dropped at the result site
// (`getWasmFuncReturnType(...) ?? resolveWasmType(...)`). The unbranded i32 then
// boxed as a JS *number* (`1`/`0`) at the `any`/return boundary instead of a JS
// *boolean* (`true`/`false`). The string-concat context below exposes it: a
// boolean stringifies "true"/"false", a number "1"/"0".
//
// Fix: `brandExternMethodResult` re-tags a bare-i32 result whose declared TS
// return type is exactly `boolean`, applied at every dispatch-result site (and
// at extern-method registration). Typed receivers, numeric methods, and
// already-externref boolean results are unchanged.

async function evalStr(body: string): Promise<unknown> {
  const exports = await compileToWasm(body);
  return (exports as { test: () => unknown }).test();
}

describe("#2770 bare-var boolean-method result brands as boolean (not number)", () => {
  it("Set.has on a bare-var receiver → true/false (not 1/0)", async () => {
    expect(
      await evalStr(
        `export function test(): string { var s: any; s = new Set([1]); return s.has(1) + "," + s.has(2); }`,
      ),
    ).toBe("true,false");
  });

  it("Set.delete on a bare-var receiver → true/false", async () => {
    expect(
      await evalStr(
        `export function test(): string { var s: any; s = new Set([1]); return s.delete(1) + "," + s.delete(9); }`,
      ),
    ).toBe("true,false");
  });

  it("Map.has on a bare-var receiver → true/false", async () => {
    expect(
      await evalStr(
        `export function test(): string { var m: any; m = new Map(); m.set(1, 9); return m.has(1) + "," + m.has(2); }`,
      ),
    ).toBe("true,false");
  });

  it("Map.delete on a bare-var receiver → true/false", async () => {
    expect(
      await evalStr(
        `export function test(): string { var m: any; m = new Map(); m.set(1, 9); return m.delete(1) + "," + m.delete(1); }`,
      ),
    ).toBe("true,false");
  });

  it("RegExp.test on a bare-var receiver → true/false (subsumes the RegExp case)", async () => {
    expect(
      await evalStr(`export function test(): string { var r: any; r = /a/g; return r.test("a") + "," + r.test("b"); }`),
    ).toBe("true,false");
  });

  it("ES2025 Set algebra predicates on a bare-var receiver → boolean", async () => {
    expect(
      await evalStr(
        `export function test(): string {
           var a: any; a = new Set([1, 2]);
           var b: any; b = new Set([1, 2, 3]);
           return a.isSubsetOf(b) + "," + a.isSupersetOf(b) + "," + a.isDisjointFrom(new Set([9]));
         }`,
      ),
    ).toBe("true,false,true");
  });
});

describe("#2770 typed-receiver booleans unchanged", () => {
  it("Set.has on a typed const receiver still → true/false", async () => {
    expect(
      await evalStr(`export function test(): string { const s = new Set([1]); return s.has(1) + "," + s.has(2); }`),
    ).toBe("true,false");
  });

  it("returns a truthy boolean value (typed receiver, raw i32 export)", async () => {
    // A `boolean`-returning wasm *export* yields the unboxed i32 (1/0) — wasm has
    // no bool type — so coerce with `!!` to check the value. This path is
    // UNCHANGED by S5b (the typed `Set_has` route already returns the right bit);
    // the brand only matters at the `any`/box boundary exercised above.
    const exports = await compileToWasm(`export function test(): boolean { const s = new Set([1]); return s.has(1); }`);
    expect(!!(exports as { test: () => unknown }).test()).toBe(true);
  });
});

describe("#2770 no over-boxing — numeric methods stay numbers", () => {
  it("Map.get on a bare-var receiver stays a number", async () => {
    expect(
      await evalStr(
        `export function test(): string { var m: any; m = new Map(); m.set(1, 42); return "" + m.get(1); }`,
      ),
    ).toBe("42");
  });

  it("Map.size on a bare-var receiver stays a number", async () => {
    expect(
      await evalStr(
        `export function test(): string { var m: any; m = new Map(); m.set(1, 9); m.set(2, 8); return "" + m.size; }`,
      ),
    ).toBe("2");
  });

  it("Array.indexOf stays a number (not a boolean)", async () => {
    expect(
      await evalStr(
        `export function test(): string { var a: any; a = [10, 20, 30]; return a.indexOf(20) + "," + a.indexOf(99); }`,
      ),
    ).toBe("1,-1");
  });
});
