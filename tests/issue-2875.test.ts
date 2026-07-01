// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2875 slice 1 — standalone reflective `String.prototype.<member>` closures.
//
// Before this slice, `String.prototype.charAt.call(thisArg, …)` in
// `--target standalone` fell through `ensureStandaloneNativeMethodClosure`
// (String's glue `emitMemberBody` returned `emitProtoMemberBodyRefusal` → null)
// AND was never even routed to `emitReflectiveNativeProtoClosureCall` — the
// interface→brand map in `tryEmitNativeProtoReflectiveCall` (calls.ts) only knew
// Array/Object, so a `String`-interface method resolved to `undefined` and
// dropped to a legacy `.call` that discards `thisArg` and returns 0. So
// `X.call(null)` neither threw (RequireObjectCoercible, §22.1.3.1 step 1) nor
// produced the correct result for a valid receiver.
//
// This slice: (1) maps the `String` interface → `ensureStringNativeProtoGlue`,
// and (2) adds `emitStringProtoMemberBody` with real native bodies for the
// index-accessor family `charAt`/`at`: RequireObjectCoercible(this) → ToString →
// `__str_charAt`, boxed to the uniform externref closure result. In standalone
// `undefined` is conflated with `null` as `ref.null.extern`, so
// RequireObjectCoercible is a host-free `ref.is_null` → throw TypeError.
//
// Native-string results are opaque WasmGC refs to the JS host, so these assert
// via boolean/number (1/0) exports computed INSIDE the module.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host import may leak under standalone (host-free pass).
  expect(r.imports ?? []).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2875 slice 1 — reflective String.prototype.{charAt,at}.call in standalone", () => {
  it("charAt.call(null) throws TypeError (RequireObjectCoercible)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.charAt as any).call(null, 0); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("charAt.call(undefined) throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.charAt as any).call(undefined, 0); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("charAt.call('abc', 1) === 'b' (valid reflective receiver)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.charAt as any).call("abc", 1); return (c === "b") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("charAt.call(true, 0) coerces boolean this via ToString: 'true'.charAt(0) === 't'", async () => {
    // ToString of a coercible non-string receiver. (Full ToString of every value
    // kind — e.g. a boxed NUMBER receiver — depends on the `$__any_to_string`
    // substrate (#2862) and is out of scope for this slice; the test262 charAt/at
    // receiver-coercion tests use null/undefined or a string, all covered here.)
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.charAt as any).call(true, 0); return (c === "t") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("at.call(null) throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.at as any).call(null, 0); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("at.call('abc', -1) === 'c' (negative index)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.at as any).call("abc", -1); return (c === "c") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("at.call('abc', 9) === undefined (out of range)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.at as any).call("abc", 9); return (c === undefined) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  // ── Regression guards ──
  it("direct 'abc'.charAt(1) still works (non-reflective path unaffected)", async () => {
    expect(await runStandalone(`export function test(): number { return ("abc".charAt(1) === "b") ? 1 : 0; }`)).toBe(1);
  });

  it("direct 'abc'.at(-1) still works", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = "abc".at(-1); return (c === "c") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Array.prototype.slice.call still works (other-brand reflective path unaffected)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = [1, 2, 3]; const s: any = (Array.prototype.slice as any).call(a, 1, 3); return (s.length === 2 && s[0] === 2) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
