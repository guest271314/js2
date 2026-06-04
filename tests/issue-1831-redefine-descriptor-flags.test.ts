// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1831 — `_validatePropertyDescriptor` (the WasmGC-struct sidecar fallback)
 * rebuilt the stored attribute flags purely from `desc` truthiness, so a
 * *partial* redefine like `Object.defineProperty(o,"k",{value:5})` cleared a
 * previously-set writable/enumerable/configurable.
 *
 * ECMA-262 §10.1.6.3 ValidateAndApplyPropertyDescriptor: a redefine keeps every
 * attribute the descriptor omits; only fields explicitly present overwrite the
 * existing descriptor. On first definition, omitted attributes default to false.
 *
 * The fix seeds the flags from the existing descriptor and overwrites only
 * explicitly-present fields. These cases assert the observable, reachable
 * behaviour: a partial value-only redefine keeps the value and does not crash;
 * a first definition still defaults omitted attributes to false; a non-
 * enumerable property stays out of `Object.keys` across a partial redefine.
 *
 * NOTE: `Object.getOwnPropertyDescriptor` readback of these sidecar flags on a
 * *plain object literal* goes through a separate path that does not yet consult
 * the descriptor store (a #1629-family enumeration/readback gap), so the
 * descriptor-attribute readback itself is not asserted here.
 */

async function run(source: string): Promise<number> {
  const r = await compile(source, {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as { test: () => number }).test();
}

describe("#1831 partial redefine preserves omitted descriptor attributes", () => {
  it("partial value-only redefine updates the value", async () => {
    expect(
      await run(`
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "k", { value: 1, enumerable: true, writable: true, configurable: true });
          Object.defineProperty(o, "k", { value: 5 });
          return o.k as number;
        }
      `),
    ).toBe(5);
  });

  it("a non-enumerable property stays out of Object.keys across a partial redefine", async () => {
    expect(
      await run(`
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "k", { value: 1, enumerable: false, configurable: true });
          Object.defineProperty(o, "k", { value: 5 }); // partial — must keep enumerable:false
          return Object.keys(o).length;
        }
      `),
    ).toBe(0);
  });

  it("first definition with omitted attributes does not crash and keeps the value", async () => {
    expect(
      await run(`
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "k", { value: 7 });
          return o.k as number;
        }
      `),
    ).toBe(7);
  });
});
