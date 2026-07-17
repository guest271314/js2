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

describe("#3150 — Uint8Array.fromBase64 (standalone)", () => {
  it("decodes length correctly ('aGVsbG8=' → 5)", async () => {
    expect(
      await runStandalone(`export function test(): number { return Uint8Array.fromBase64("aGVsbG8=").length; }`),
    ).toBe(5);
  });

  it("decodes bytes ('Zm9v' → [102,111,111])", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Uint8Array.fromBase64("Zm9v"); return a[0]*1000000 + a[1]*1000 + a[2]; }`,
      ),
    ).toBe(102 * 1000000 + 111 * 1000 + 111);
  });

  it("empty string → empty array", async () => {
    expect(await runStandalone(`export function test(): number { return Uint8Array.fromBase64("").length; }`)).toBe(0);
  });

  it("single '=' padding ('aGVsbG8=' first byte 'h' = 104)", async () => {
    expect(await runStandalone(`export function test(): number { return Uint8Array.fromBase64("aGVsbG8=")[0]; }`)).toBe(
      104,
    );
  });

  it("'aGk=' decodes to 'hi' (2 bytes, first = 104)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Uint8Array.fromBase64("aGk="); return a.length*1000 + a[0]; }`,
      ),
    ).toBe(2 * 1000 + 104);
  });

  it("loose last-chunk: unpadded 3-char 'aGk' still decodes ('hi')", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Uint8Array.fromBase64("aGk"); return a.length*1000 + a[0]; }`,
      ),
    ).toBe(2 * 1000 + 104);
  });

  it("ASCII whitespace between chars is skipped ('Zm 9v' → 3 bytes)", async () => {
    expect(
      await runStandalone(`export function test(): number { return Uint8Array.fromBase64("Zm 9v").length; }`),
    ).toBe(3);
  });

  it("illegal character throws SyntaxError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { Uint8Array.fromBase64("Zm@v"); return -1; } catch (e) { return (e instanceof SyntaxError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("single trailing character throws SyntaxError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { Uint8Array.fromBase64("A"); return -1; } catch (e) { return (e instanceof SyntaxError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("base64 character after padding throws SyntaxError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { Uint8Array.fromBase64("aGk=A"); return -1; } catch (e) { return (e instanceof SyntaxError) ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("does not leak host imports (zero-import instantiation)", async () => {
    const r = await compile(`export function test(): number { return Uint8Array.fromBase64("aGk=").length; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(2);
  });
});

describe("#3150 — Uint8Array.prototype.toHex / toBase64 (standalone)", () => {
  // Bytes are proven byte-exact via `.length` + `.charCodeAt(i)` reads; the
  // `const s: string = …` binding also confirms the string reads back through
  // the ordinary native-string surface. (Direct `myStr === "literal"` is NOT
  // used: `toHex`/`toBase64` are not in the bundled TS lib so the checker types
  // the result `any`, and the `any === <literal>` fast-path is reference-eq —
  // the static return-type branding gap tracked separately in this issue. The
  // runtime string is correct; test262's `assert.sameValue(any, any)` compares
  // by content and passes.)

  it("toHex length = 2 * byteLength", async () => {
    expect(
      await runStandalone(`export function test(): number { return Uint8Array.of(102, 111, 111).toHex().length; }`),
    ).toBe(6);
  });

  it("toHex encodes '666f6f' for [102,111,111] (lowercase)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Uint8Array.of(102, 111, 111).toHex(); return (s.charCodeAt(0)===54 && s.charCodeAt(1)===54 && s.charCodeAt(2)===54 && s.charCodeAt(3)===102 && s.charCodeAt(4)===54 && s.charCodeAt(5)===102) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("toHex encodes high byte + zero + low ('ff000a' for [255,0,10])", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s: string = Uint8Array.of(255, 0, 10).toHex(); return (s.length===6 && s.charCodeAt(0)===102 && s.charCodeAt(1)===102 && s.charCodeAt(2)===48 && s.charCodeAt(3)===48 && s.charCodeAt(4)===48 && s.charCodeAt(5)===97) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("toHex of empty array is empty string", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: Uint8Array = Uint8Array.of(); return a.toHex().length; }`,
      ),
    ).toBe(0);
  });

  it("toBase64 encodes 'Zm9vYmFy' for 'foobar' bytes (full groups)", async () => {
    // "foobar" = [102,111,111,98,97,114] → "Zm9vYmFy" (90,109,57,118,89,109,70,121)
    expect(
      await runStandalone(
        `export function test(): number { const s = Uint8Array.of(102,111,111,98,97,114).toBase64(); const e = [90,109,57,118,89,109,70,121]; if (s.length !== 8) return 0; for (let i=0;i<8;i++){ if (s.charCodeAt(i)!==e[i]) return 0; } return 1; }`,
      ),
    ).toBe(1);
  });

  it("toBase64 pads a 2-byte tail with one '=' ('Zm8=')", async () => {
    // [102,111] → "Zm8=" (90,109,56,61)
    expect(
      await runStandalone(
        `export function test(): number { const s = Uint8Array.of(102,111).toBase64(); const e=[90,109,56,61]; if (s.length!==4) return 0; for(let i=0;i<4;i++){if(s.charCodeAt(i)!==e[i])return 0;} return 1; }`,
      ),
    ).toBe(1);
  });

  it("toBase64 pads a 1-byte tail with two '=' ('Zg==')", async () => {
    // [102] → "Zg==" (90,103,61,61)
    expect(
      await runStandalone(
        `export function test(): number { const s = Uint8Array.of(102).toBase64(); const e=[90,103,61,61]; if (s.length!==4) return 0; for(let i=0;i<4;i++){if(s.charCodeAt(i)!==e[i])return 0;} return 1; }`,
      ),
    ).toBe(1);
  });

  it("toBase64 emits '+' and '/' for the 62/63 sextets", async () => {
    // [251,255,191] → "+/+/" (43,47,43,47)
    expect(
      await runStandalone(
        `export function test(): number { const s = Uint8Array.of(251,255,191).toBase64(); const e=[43,47,43,47]; if (s.length!==4) return 0; for(let i=0;i<4;i++){if(s.charCodeAt(i)!==e[i])return 0;} return 1; }`,
      ),
    ).toBe(1);
  });

  it("toBase64 of empty array is empty string", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: Uint8Array = Uint8Array.of(); return a.toBase64().length; }`,
      ),
    ).toBe(0);
  });

  it("toHex/toBase64 do not leak host imports (zero-import instantiation)", async () => {
    const r = await compile(
      `export function test(): number { return Uint8Array.of(1,2,3).toHex().length + Uint8Array.of(1,2,3).toBase64().length; }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(6 + 4);
  });
});
