// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2875 slice 2 — reflective String.prototype.{charCodeAt,codePointAt} closures.
//
// Extends the slice-1 `emitStringProtoMemberBody` (charAt/at) with the two
// number-returning index accessors. Same shape — RequireObjectCoercible(this)
// (host-free `ref.is_null` throw) → ToString(this) → the UTF-16 read — but the
// result is an f64 boxed to externref via `__box_number` (host-free native in
// standalone). `charCodeAt` returns NaN out of range (§22.1.3.3); `codePointAt`
// returns undefined out of range and combines a leading+trailing surrogate pair
// into a full code point (§22.1.3.4).
//
// The `__box_number` late import is ensured in the SAME first batch as
// `__unbox_number` (before any helper funcIdx is fetched by name), preserving the
// funcidx-shift discipline.
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

describe("#2875 slice 2 — reflective String.prototype.{charCodeAt,codePointAt}.call", () => {
  it("charCodeAt.call(null) throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.charCodeAt as any).call(null, 0); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("charCodeAt.call('ABC', 1) === 66", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const n: any = (String.prototype.charCodeAt as any).call("ABC", 1); return (n === 66) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("charCodeAt.call('ABC', 9) is NaN (out of range)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const n: any = (String.prototype.charCodeAt as any).call("ABC", 9); return (typeof n === "number" && isNaN(n)) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("codePointAt.call(null) throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.codePointAt as any).call(null, 0); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("codePointAt.call('ABC', 0) === 65", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const n: any = (String.prototype.codePointAt as any).call("ABC", 0); return (n === 65) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("codePointAt.call('ABC', 9) === undefined (out of range)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const n: any = (String.prototype.codePointAt as any).call("ABC", 9); return (n === undefined) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("codePointAt.call('😀', 0) === 128512 (surrogate pair combined)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = "\\uD83D\\uDE00"; const n: any = (String.prototype.codePointAt as any).call(s, 0); return (n === 128512) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("codePointAt.call('😀', 1) === 56832 (lone trailing surrogate at pos 1)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = "\\uD83D\\uDE00"; const n: any = (String.prototype.codePointAt as any).call(s, 1); return (n === 0xDE00) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  // ── Regression guards ──
  it("direct 'ABC'.charCodeAt(2) === 67 still works", async () => {
    expect(await runStandalone(`export function test(): number { return ("ABC".charCodeAt(2) === 67) ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("slice-1 charAt.call still works alongside slice-2", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.charAt as any).call("abc", 2); return (c === "c") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
