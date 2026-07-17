// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3150 — standalone-native Uint8Array.fromHex(string) decode.
//
// The ES2025 base64/hex proposal static `Uint8Array.fromHex` used to hard-CE
// standalone through the __get_builtin dynamic-shape refusal (#1472 Phase B).
// This slice lowers it to a native hex-decode byte loop writing into the
// packed-i8 Uint8Array vec, with the spec's SyntaxError on odd length / illegal
// characters. Options / fromBase64 / instance toHex/setFromHex are follow-ups.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#3150 — Uint8Array.fromHex (standalone)", () => {
  it("decodes length correctly", async () => {
    expect(await runStandalone(`export function test(): number { return Uint8Array.fromHex("6869").length; }`)).toBe(2);
  });

  it("decodes bytes ('666f6f' → [102,111,111])", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Uint8Array.fromHex("666f6f"); return a[0]*1000000 + a[1]*1000 + a[2]; }`,
      ),
    ).toBe(102 * 1000000 + 111 * 1000 + 111);
  });

  it("empty string → empty array", async () => {
    expect(await runStandalone(`export function test(): number { return Uint8Array.fromHex("").length; }`)).toBe(0);
  });

  it("is case-insensitive ('666F' === '666f')", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Uint8Array.fromHex("666F"); return a[0]*1000 + a[1]; }`,
      ),
    ).toBe(102 * 1000 + 111);
  });

  it("odd-length input throws SyntaxError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { Uint8Array.fromHex("a"); return -1; } catch (e) { return (e instanceof SyntaxError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("illegal character throws SyntaxError (space)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { Uint8Array.fromHex("a a"); return -1; } catch (e) { return (e instanceof SyntaxError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("illegal character throws SyntaxError (nbsp / non-ASCII)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { Uint8Array.fromHex("a\\u00A0a"); return -1; } catch (e) { return (e instanceof SyntaxError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("does not leak host imports (zero-import instantiation)", async () => {
    const r = await compile(`export function test(): number { return Uint8Array.fromHex("6869").length; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    // Standalone modules must instantiate with NO import object.
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(2);
  });
});
