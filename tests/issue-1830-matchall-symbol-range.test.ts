// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1830 — well-known-symbol range guard off-by-one excluded Symbol.matchAll.
 *
 * `_symbolIdToKeys` (src/runtime.ts) maps well-known-symbol IDs 1-15, where
 * 15 = `@@matchAll`. But the runtime get/set/has remapping guards
 * (`_safeGet`, `_safeSet`, `__extern_has`) and `__symbol_register_desc` all
 * gated on `<= 14`, so a numeric symbol-id 15 (`@@matchAll`) reaching those
 * paths on a WasmGC struct fell through to numeric-index access and missed the
 * symbol-keyed property. The fix widens all four bounds to `<= 15` (matching
 * the authoritative map).
 *
 * Smoke guard: `Symbol.matchAll`-keyed access compiles to a valid,
 * instantiable module (the guard widening cannot regress the in-range symbols;
 * test262 `@@matchAll` struct routing covers the behavioral surface).
 */

describe("#1830 Symbol.matchAll (id 15) within the well-known-symbol range", () => {
  it("Symbol.matchAll computed-key access compiles to a valid module", async () => {
    const r = await compile(
      `
        export function probe(): number {
          const o: any = { [Symbol.matchAll]: 7 };
          return (Symbol.matchAll in o) ? 1 : 0;
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Must produce an instantiable binary (regression guard against codegen breakage).
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    expect(typeof (instance.exports as { probe: () => number }).probe).toBe("function");
  });

  it("other well-known symbols (Symbol.iterator id 1, Symbol.asyncDispose id 14) still compile", async () => {
    const r = await compile(
      `
        export function probe(): number {
          const a: any = { [Symbol.iterator]: 1 };
          const b: any = { [Symbol.asyncDispose]: 2 };
          return (Symbol.iterator in a ? 0 : 1) + (Symbol.asyncDispose in b ? 0 : 1);
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    expect(typeof (instance.exports as { probe: () => number }).probe).toBe("function");
  });
});
