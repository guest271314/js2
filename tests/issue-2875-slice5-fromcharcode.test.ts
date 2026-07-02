// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2875 slice 5 — String.fromCharCode ToUint16 (§7.1.8) + zero-arg calls.
//
// Two standalone bugs in the fromCharCode family lowering:
//
// 1. The native lane coerced each f64 argument with a bare
//    `i32.trunc_sat_f64_s`, which SATURATES before the helper's low-16 mask:
//    +Infinity → 0x7FFFFFFF → & 0xFFFF = 0xFFFF instead of the spec's +0
//    (ToUint16 maps NaN/±∞ → +0), and any |x| ≥ 2^31 lost its true modulus
//    the same way (fromCharCode(2^32+65) must be "A"). Fixed by computing
//    ToUint16 in the f64 domain first — t = trunc(x); m = t −
//    floor(t/2^16)·2^16 — which is exact for all finite f64s (division by
//    2^16 is an exponent shift) and propagates NaN/±∞ to a NaN that
//    i32.trunc_sat maps to +0.
//
// 2. Zero-arg `String.fromCharCode()` is spec-valid (§22.1.2.1 — "") but an
//    `arguments.length >= 1` gate dropped it to the generic member-call path,
//    a `__get_builtin` Phase-B refusal → CE in standalone (S15.5.3.2_A2).
//    Same for `String.fromCodePoint()` (§22.1.2.2).
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

describe("#2875 slice 5 — fromCharCode ToUint16 (§7.1.8)", () => {
  it("fromCharCode(+Infinity).charCodeAt(0) === 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (String.fromCharCode(Number.POSITIVE_INFINITY).charCodeAt(0) === 0) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("fromCharCode(-Infinity).charCodeAt(0) === 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (String.fromCharCode(Number.NEGATIVE_INFINITY).charCodeAt(0) === 0) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("fromCharCode(NaN).charCodeAt(0) === 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (String.fromCharCode(NaN).charCodeAt(0) === 0) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("fromCharCode(2^32 + 65) === 'A' (true modulo, not saturation)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (String.fromCharCode(4294967361) === "A") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("fromCharCode(-32767).charCodeAt(0) === 32769 (negative wrap)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (String.fromCharCode(-32767).charCodeAt(0) === 32769) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("fromCharCode(65.9) === 'A' (truncate toward zero)", async () => {
    expect(
      await runStandalone(`export function test(): number { return (String.fromCharCode(65.9) === "A") ? 1 : 0; }`),
    ).toBe(1);
  });
});

describe("#2875 slice 5 — zero-arg fromCharCode/fromCodePoint", () => {
  it("String.fromCharCode() === ''", async () => {
    expect(
      await runStandalone(`export function test(): number { return (String.fromCharCode() === "") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("String.fromCodePoint() === ''", async () => {
    expect(
      await runStandalone(`export function test(): number { return (String.fromCodePoint() === "") ? 1 : 0; }`),
    ).toBe(1);
  });

  // ── Regression guards ──
  it("fromCharCode(72, 105) === 'Hi' (variadic unchanged)", async () => {
    expect(
      await runStandalone(`export function test(): number { return (String.fromCharCode(72, 105) === "Hi") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("fromCodePoint(0x1F600).length === 2 (surrogate pair unchanged)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (String.fromCodePoint(128512).length === 2) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("fromCodePoint(-1) throws RangeError (range guard unchanged)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { String.fromCodePoint(-1); return 0; } catch (e) { return (e instanceof RangeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });
});
