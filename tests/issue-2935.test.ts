// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2935 — `__str_flatten` null-deref on String-wrapper `.split(RegExp)` /
// `.replace(RegExp, …)` (regression lock).
//
// Under `--target standalone`, calling `.split(regexp)` / `.replace(regexp, …)`
// on a String WRAPPER receiver (`new String(...)`, or a var typed `String`)
// used to trap at runtime — `dereferencing a null pointer in __str_flatten()` —
// because the RegExp split/replace lowering handed the wrapper `$Object`
// receiver to the native `__str_flatten` helper WITHOUT first performing the
// `thisStringValue` unwrap to recover the primitive `$AnyString`. The intervening
// borrowed-receiver ToString/RequireObjectCoercible work (PR #3254 / #2934)
// now unwraps the wrapper before flatten, so the wrapper receiver runs host-free
// and matches the primitive receiver. This test locks that: the wrapper repro
// must compile to valid standalone Wasm, instantiate with NO import object, and
// produce the same result as the primitive receiver.
//
// Results are asserted on numeric derivations (`.length` / `.charCodeAt`) rather
// than the string value itself: a raw standalone `$AnyString` return marshals to
// `undefined` across the JS boundary (a harness artifact, not a codegen bug), so
// the string is consumed inside Wasm and only a number crosses out.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  // Standalone modules must instantiate with NO import object (host-free).
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2935 — String-wrapper receiver .split/.replace(RegExp) (standalone)", () => {
  it("new String(...).split(/re/) runs host-free (no __str_flatten null-deref)", async () => {
    // "abc".split(/[a-z]/) -> ["", "", "", ""] -> length 4
    expect(
      await runStandalone(
        `export function test(): number { const s = new String("abc"); return s.split(/[a-z]/).length; }`,
      ),
    ).toBe(4);
  });

  it("wrapper split content matches primitive receiver", async () => {
    // "aXbXc".split(/X/) -> ["a", "b", "c"] -> length 3
    expect(
      await runStandalone(
        `export function test(): number { const s = new String("aXbXc"); return s.split(/X/).length; }`,
      ),
    ).toBe(3);
    expect(await runStandalone(`export function test(): number { return "aXbXc".split(/X/).length; }`)).toBe(3);
  });

  it("new String(...).replace(/re/, repl) replaces the first match, host-free", async () => {
    // "abc".replace(/[a-z]/, "X") -> "Xbc" -> length 3, first char 'X' (88)
    expect(
      await runStandalone(
        `export function test(): number { const s = new String("abc"); return s.replace(/[a-z]/, "X").length; }`,
      ),
    ).toBe(3);
    expect(
      await runStandalone(
        `export function test(): number { const s = new String("abc"); return s.replace(/[a-z]/, "X").charCodeAt(0); }`,
      ),
    ).toBe(88); // 'X'
  });

  it("wrapper .replace(/re/g, …) honors the global flag", async () => {
    // "abcabc".replace(/b/g, "X") -> "aXcaXc" -> length 6
    expect(
      await runStandalone(
        `export function test(): number { const s = new String("abcabc"); return s.replace(/b/g, "X").length; }`,
      ),
    ).toBe(6);
  });

  it("a var typed `String` (wrapper type) unwraps before flatten", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s: String = new String("a1b2c3"); return s.split(/[0-9]/).length; }`,
      ),
    ).toBe(4); // ["a","b","c",""]
  });
});
