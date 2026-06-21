import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2187 — string method/property on an `any`-typed local whose compiled ValType
// is a native `$AnyString` ref. Surfaced via #2171 string-yield generators in
// standalone: the for-of loop var infers `any` (no lib types), but is compiled
// to a `(ref null $AnyString)` local. The `.length`/string-method dispatch gated
// on `isStringType(<static type>)` missed it, so `v.length` / `v.charCodeAt(0)`
// fell to the generic externref path → 0. The fix routes by the local ValType
// (receiverIsNativeStringValType) when the TS type is `any`/`unknown`.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2187 string method on any-typed native-string local", () => {
  it("for-of string generator var: v.length sums correctly", async () => {
    expect(
      await runStandalone(
        `function* g(){ yield "ab"; } export function test(): number { let n = 0; for (const v of g()) n += v.length; return n; }`,
      ),
    ).toBe(2);
  });

  it("for-of string generator var: v.charCodeAt(0)", async () => {
    expect(
      await runStandalone(
        `function* g(){ yield "A"; } export function test(): number { let r = 0; for (const v of g()) r = v.charCodeAt(0); return r; }`,
      ),
    ).toBe(65);
  });

  it("v.length assigned to a typed local", async () => {
    expect(
      await runStandalone(
        `function* g(){ yield "abc"; } export function test(): number { let r = 0; for (const v of g()) { const L = v.length; r = L; } return r; }`,
      ),
    ).toBe(3);
  });

  it("return v.length directly from the loop", async () => {
    expect(
      await runStandalone(
        `function* g(){ yield "wxyz"; } export function test(): number { for (const v of g()) { return v.length; } return -1; }`,
      ),
    ).toBe(4);
  });

  // Regression guards — typed string / literal / numeric generator unchanged.
  it("typed string .length unchanged", async () => {
    expect(await runStandalone(`export function test(): number { const s: string = "hello"; return s.length; }`)).toBe(
      5,
    );
  });

  it("string literal .length unchanged", async () => {
    expect(await runStandalone(`export function test(): number { return "world".length; }`)).toBe(5);
  });

  it("typed string charCodeAt unchanged", async () => {
    expect(
      await runStandalone(`export function test(): number { const s: string = "A"; return s.charCodeAt(0); }`),
    ).toBe(65);
  });

  it("numeric generator var is not string-routed", async () => {
    expect(
      await runStandalone(
        `function* g(){ yield 10; yield 20; } export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`,
      ),
    ).toBe(30);
  });

  it("array .length unchanged", async () => {
    expect(await runStandalone(`export function test(): number { const a = [1,2,3]; return a.length; }`)).toBe(3);
  });
});
