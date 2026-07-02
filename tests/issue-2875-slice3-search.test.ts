// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2875 slice 3 — reflective String.prototype search-family closures
// (indexOf/lastIndexOf/includes/startsWith/endsWith) + native-core position
// clamps.
//
// Root cause of the original slice-3 invalid-Wasm: the reflective closure's
// lifted func type sized its user params to the member's SPEC arity
// (`fn.length` — 1 for the whole search family, the optional position is
// uncounted), so the body's `local.get 3` for the position arg landed on the
// first DECLARED LOCAL instead of a param and fed `__unbox_number(externref)`
// an i32 ("call[0] expected externref, found local.get of type i32"). Fixed by
// `NativeProtoBuiltinGlue.memberParamSlots` — the closure sizes to
// max(spec arity, ABI slots) while `.length` metadata keeps the spec arity.
//
// Also fixes the §22.1.3.{23,6,9} `min(max(pos, 0), len)` clamps missing from
// the `__str_startsWith` / `__str_endsWith` / `__str_lastIndexOf` native cores
// (negative or Infinity positions trapped OOB or returned wrong results on the
// DIRECT path too).
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

describe("#2875 slice 3a — reflective String.prototype.{indexOf,lastIndexOf}.call", () => {
  it("indexOf.call('abcabc', 'b') === 1", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.indexOf as any).call("abcabc", "b"); return (v === 1) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("indexOf.call('abcabc', 'b', 2) === 4 (the optional position param exists)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.indexOf as any).call("abcabc", "b", 2); return (v === 4) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("indexOf.call('abc', 'z') === -1", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.indexOf as any).call("abc", "z"); return (v === -1) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("indexOf.call(null, 'a') throws TypeError (RequireObjectCoercible)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.indexOf as any).call(null, "a"); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("lastIndexOf.call('abcabc', 'b') === 4 (absent position → from end)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.lastIndexOf as any).call("abcabc", "b"); return (v === 4) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("lastIndexOf.call('abcabc', 'b', 3) === 1", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.lastIndexOf as any).call("abcabc", "b", 3); return (v === 1) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("lastIndexOf.call(undefined, 'a') throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.lastIndexOf as any).call(undefined, "a"); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });
});

describe("#2875 slice 3b — reflective String.prototype.{includes,startsWith,endsWith}.call", () => {
  it("includes.call('abcabc', 'ca') === true (a real JS boolean)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.includes as any).call("abcabc", "ca"); return (v === true) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("includes.call('abcabc', 'a', 4) === false (position honored)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.includes as any).call("abcabc", "a", 4); return (v === false) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("includes.call(null, '') throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.includes as any).call(null, ""); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("startsWith.call('abcabc', 'ca', 2) === true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.startsWith as any).call("abcabc", "ca", 2); return (v === true) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("startsWith.call(null, '') throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.startsWith as any).call(null, ""); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("endsWith.call('abcabc', 'ab', 2) === true (endPosition honored)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.endsWith as any).call("abcabc", "ab", 2); return (v === true) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("endsWith.call('abcabc', 'bc') === true (absent endPosition → len)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = (String.prototype.endsWith as any).call("abcabc", "bc"); return (v === true) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("endsWith.call(undefined, '') throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { (String.prototype.endsWith as any).call(undefined, ""); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });
});

describe("#2875 slice 3 — §22.1.3 position clamps in the native cores (direct path)", () => {
  it("startsWith('', Infinity) === true (empty search at clamped end)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return ('The future is cool!'.startsWith('', Infinity) === true) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("startsWith('!', Infinity) === false (no OOB trap on INT_MAX position)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return ('The future is cool!'.startsWith('!', Infinity) === false) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("startsWith('The future', -1) === true (negative position clamps to 0)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return ('The future is cool!'.startsWith('The future', -1) === true) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("endsWith('', -1) === true (negative endPosition clamps to 0)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return ('The future is cool!'.endsWith('', -1) === true) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("lastIndexOf('a', -1) === 0 (negative fromIndex clamps to 0)", async () => {
    expect(
      await runStandalone(`export function test(): number { return ("abc".lastIndexOf("a", -1) === 0) ? 1 : 0; }`),
    ).toBe(1);
  });

  // ── Regression guards ──
  it("direct 'abcabc'.indexOf('b', 2) === 4 still works", async () => {
    expect(
      await runStandalone(`export function test(): number { return ("abcabc".indexOf("b", 2) === 4) ? 1 : 0; }`),
    ).toBe(1);
  });

  it("direct 'abcabc'.lastIndexOf('b') === 4 still works", async () => {
    expect(
      await runStandalone(`export function test(): number { return ("abcabc".lastIndexOf("b") === 4) ? 1 : 0; }`),
    ).toBe(1);
  });

  it("slice-1/2 charAt + charCodeAt reflective calls still work alongside slice 3", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.charAt as any).call("abc", 2); const n: any = (String.prototype.charCodeAt as any).call("ABC", 1); return (c === "c" && n === 66) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
