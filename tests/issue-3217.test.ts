// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3217 — reflective String.prototype.{trim,trimStart,trimEnd}.call in
// standalone mode. Before this slice the reflective closure body for the
// whitespace-trim family REFUSED (emitProtoMemberBodyRefusal), so the call fell
// through to the legacy `.call` lowering, which for primitive / array receivers
// emitted INVALID Wasm ("call[0] expected (ref null N), found i32.const") — 31
// trim-family test262 files were compile_error on that path. The new
// `emitStringTrimMemberBody` runs `? RequireObjectCoercible(this)` →
// `S = ? ToString(this)` → the native `__str_trim*` kernel, producing a valid
// host-free binary in every case.
//
// Residual (out of scope, see the issue): `.call(<boolean|number|array>)`
// returns the CORRECT trimmed string but the value fails the caller's
// `assert.sameValue` because a primitive-coerced string externref is not
// recovered as a native string by the `any === any` substrate path (the same
// gap makes `String(false) === "false"` fail). Hence the value assertions below
// use STRING receivers (which the substrate handles), and the primitive case is
// asserted only for host-free validity + `typeof === "string"`.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(r.imports ?? []).toEqual([]); // host-free
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3217 — reflective String.prototype.{trim,trimStart,trimEnd}.call (standalone)", () => {
  it("trim.call('  x  ') === 'x'", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.trim as any).call("  x  "); return (v === "x") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("trimStart.call('  x  ') === 'x  ' (leading only)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.trimStart as any).call("  x  "); return (v === "x  ") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("trimEnd.call('  x  ') === '  x' (trailing only)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.trimEnd as any).call("  x  "); return (v === "  x") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("trim.call(null) throws TypeError (RequireObjectCoercible)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.trim as any).call(null); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("trimEnd.call(undefined) throws TypeError (RequireObjectCoercible)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.trimEnd as any).call(undefined); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("trim.call(false) compiles to a valid host-free binary and yields a string (no invalid Wasm)", async () => {
    // The previously-invalid-Wasm path: a boolean receiver. runStandalone
    // asserts host-free + WebAssembly.validate; typeof proves ToString ran.
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.trim as any).call(false); return (typeof v === "string") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("trim.call([1]) compiles to a valid host-free binary (array receiver, was invalid Wasm)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.trim as any).call([1]); return (typeof v === "string") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
