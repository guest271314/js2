// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2400 — Wasm-native `encodeURI` / `encodeURIComponent` (ECMAScript §19.2.6.5
 * Encode) for standalone / WASI.
 *
 * In JS-host mode these are `env.*` imports. Under `--target wasi`/`--target
 * standalone` there is no host, so the call site previously fell through to a
 * `ref.test`/`ref.cast` of the argument and returned `undefined` (~133
 * `built-ins/{encodeURI,encodeURIComponent}` test262 fail).
 *
 * S1 of the slice plan: the pure-Wasm `__uri_encode(s, preservedMask)` helper
 * (`src/codegen/uri-encoding-native.ts`) — UTF-8 transcode (RFC 3629, 1–4
 * octets) + surrogate-pair handling, the per-variant preserved-set mask
 * (encodeURIComponent = `uriUnescaped`; encodeURI = + `uriReserved` ∪ `#`), and
 * **URIError** on unpaired surrogates.
 *
 * Every standalone case instantiates with an EMPTY import object, proving no JS
 * host is needed. Exported functions return NUMBERS (`.length` / `.charCodeAt`)
 * so the result reads back without needing a string-marshaling host.
 */

// One module, one export per case — numeric returns only.
type Case = { name: string; src: string; want: number };

const CASES: ReadonlyArray<Case> = [
  // ── encodeURIComponent: ASCII passthrough + percent-encoding ──
  // "a b&c" -> "a%20b%26c" (length 9)
  { name: "compLen", src: `return encodeURIComponent("a b&c").length;`, want: 9 },
  { name: "compC0", src: `return encodeURIComponent("a b&c").charCodeAt(0);`, want: 97 /* 'a' */ },
  { name: "compC1", src: `return encodeURIComponent("a b&c").charCodeAt(1);`, want: 37 /* '%' */ },
  { name: "compC2", src: `return encodeURIComponent("a b&c").charCodeAt(2);`, want: 50 /* '2' */ },
  { name: "compC3", src: `return encodeURIComponent("a b&c").charCodeAt(3);`, want: 48 /* '0' */ },
  // uriUnescaped marks all pass through: - _ . ! ~ * ' ( )
  { name: "unreserved", src: `return encodeURIComponent("-_.!~*'()").length;`, want: 9 },
  // alphanumerics pass through
  { name: "alnum", src: `return encodeURIComponent("abcXYZ0189").length;`, want: 10 },
  // reserved chars ARE escaped by encodeURIComponent: / ? : @ & = + $ , #
  { name: "compReserved", src: `return encodeURIComponent("/?:@&=+$,#").length;`, want: 30 /* 10 × %XX */ },

  // ── multi-byte UTF-8 ──
  // U+00A9 © -> %C2%A9 (2 octets, 6 chars)
  { name: "twoByte", src: `return encodeURIComponent(String.fromCharCode(0xA9)).length;`, want: 6 },
  // U+20AC € -> %E2%82%AC (3 octets, 9 chars)
  { name: "threeByteLen", src: `return encodeURIComponent("€").length;`, want: 9 },
  { name: "threeByteC1", src: `return encodeURIComponent("€").charCodeAt(1);`, want: 69 /* 'E' */ },
  { name: "threeByteC2", src: `return encodeURIComponent("€").charCodeAt(2);`, want: 50 /* '2' */ },
  // U+1F600 😀 (D83D DE00) -> %F0%9F%98%80 (4 octets, 12 chars)
  { name: "fourByteLen", src: `return encodeURIComponent(String.fromCharCode(0xD83D, 0xDE00)).length;`, want: 12 },
  {
    name: "fourByteC1",
    src: `return encodeURIComponent(String.fromCharCode(0xD83D, 0xDE00)).charCodeAt(1);`,
    want: 70 /* 'F' */,
  },

  // ── encodeURI: reserved set ∪ # passes through ──
  // "a b/c" -> "a%20b/c" (length 7, '/' preserved)
  { name: "uriLen", src: `return encodeURI("a b/c").length;`, want: 7 },
  { name: "uriC4", src: `return encodeURI("a b/c").charCodeAt(4);`, want: 98 /* 'b' */ },
  // all reserved+# pass through unchanged: ; / ? : @ & = + $ , #
  { name: "uriReserved", src: `return encodeURI(";/?:@&=+$,#").length;`, want: 11 },
  // but space is still escaped by encodeURI
  { name: "uriSpace", src: `return encodeURI(" ").length;`, want: 3 /* %20 */ },

  // ── URIError on unpaired surrogates ──
  {
    name: "loneHigh",
    src: `try { encodeURIComponent(String.fromCharCode(0xD800)); return 0; } catch (e) { return (e instanceof URIError) ? 1 : 2; }`,
    want: 1,
  },
  {
    name: "loneLow",
    src: `try { encodeURIComponent(String.fromCharCode(0xDC00)); return 0; } catch (e) { return (e instanceof URIError) ? 1 : 2; }`,
    want: 1,
  },
  {
    name: "highThenAscii",
    src: `try { encodeURIComponent(String.fromCharCode(0xD800, 0x41)); return 0; } catch (e) { return (e instanceof URIError) ? 1 : 2; }`,
    want: 1,
  },

  // ── empty string ──
  { name: "empty", src: `return encodeURIComponent("").length;`, want: 0 },
];

const MODULE_SRC = CASES.map((c) => `export function ${c.name}(): number { ${c.src} }`).join("\n");

describe("#2400 Wasm-native encodeURI / encodeURIComponent (standalone)", () => {
  it("compiles standalone with no host imports and matches the spec", async () => {
    const result = await compile(MODULE_SRC, { fileName: "uri.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    // No `env.{encode,decode}URI*` host import may leak in standalone mode.
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
    expect(imports.filter((i) => /URI/i.test(i.name))).toEqual([]);

    // EMPTY import object — proves the module is fully self-contained.
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, () => number>;
    for (const c of CASES) {
      expect(exports[c.name](), `${c.name}: ${c.src}`).toBe(c.want);
    }
  });

  it("host mode still routes encodeURIComponent through the env import", async () => {
    const result = await compile(`export function test(): string { return encodeURIComponent("a b&c"); }`, {
      fileName: "uri.ts",
    });
    expect(result.success).toBe(true);
    const importNames = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.name);
    expect(importNames).toContain("encodeURIComponent");
  });
});
