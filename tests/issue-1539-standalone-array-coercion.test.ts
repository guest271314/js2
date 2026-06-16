// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 / #1470 / #1664 — standalone array-return must not pull the JS-host
 * `__make_iterable` import.
 *
 * The vec→externref coercion in `type-coercion.ts` attaches `env.__make_iterable`
 * (a JS-host shim that gives a WasmGC vec a `Symbol.iterator`) so JS APIs can
 * iterate it. That shim is a *host import* — emitting it in `--target standalone`
 * (a) breaks standalone purity and (b) is added LATE, shifting already-emitted
 * function indices (it was observed corrupting `__str_flatten`). Standalone keeps
 * the vec as a native WasmGC `$Vec` and consumes it with the native array ops
 * (`.length`/index/for-of) that operate on it directly — exactly how
 * `String.prototype.split` already works in-function. So the import must be
 * gated to JS-host mode only.
 *
 * This is the enabling fix for the whole array-returning-builtin-in-standalone
 * class (e.g. the #1539 RegExp `.match`/`.exec` capture-array work).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Parse the import section of a Wasm binary into `module.name` strings. */
function parseImports(buf: Uint8Array): string[] {
  const u8 = buf;
  let p = 8; // skip magic + version
  const out: string[] = [];
  const leb = (): number => {
    let r = 0;
    let s = 0;
    let b: number;
    do {
      b = u8[p++]!;
      r |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  while (p < u8.length) {
    const id = u8[p++]!;
    const len = leb();
    const end = p + len;
    if (id === 2) {
      const n = leb();
      for (let i = 0; i < n; i++) {
        const ml = leb();
        const m = new TextDecoder().decode(u8.slice(p, p + ml));
        p += ml;
        const nl = leb();
        const nm = new TextDecoder().decode(u8.slice(p, p + nl));
        p += nl;
        u8[p++]; // kind
        leb(); // type index
        out.push(`${m}.${nm}`);
      }
      break;
    }
    p = end;
  }
  return out;
}

describe("#1539/#1470 standalone array-return — no __make_iterable host import", () => {
  it("standalone string[] return emits a valid module with no host imports", async () => {
    const r = await compile(`export function run(): string[] { return "a,b,c".split(","); }`, {
      fileName: "test.ts",
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const imports = parseImports(r.binary);
    expect(imports, "standalone must not import the JS-host iterable shim").not.toContain("env.__make_iterable");
    // And the module must be structurally valid (the late-import shift this fix
    // prevents previously corrupted earlier functions like __str_flatten).
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });

  it("standalone for-of over a native array still works (consumes the WasmGC vec directly)", async () => {
    const src = `export function run(): number { let n = 0; for (const p of "a,b,c".split(",")) n += p.length; return n; }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    expect(parseImports(r.binary)).not.toContain("env.__make_iterable");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(3);
  });

  it("JS-host mode still compiles array iteration (host shim path unaffected)", async () => {
    const src = `export function f(s: string): number { let n = 0; for (const p of s.split(",")) n++; return n; }`;
    const r = await compile(src, { fileName: "test.ts" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });
});
