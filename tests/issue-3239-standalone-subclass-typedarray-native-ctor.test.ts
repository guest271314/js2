// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3239 — native `class Sub extends <TypedArray | SharedArrayBuffer>` parent
 * construction in standalone/WASI.
 *
 * Under `--target standalone`, the parent construction of an externref-backed
 * subclass of a TypedArray (`Int8Array` … `BigUint64Array`) or
 * `SharedArrayBuffer` lowered to a distinct `env::__new_<Parent>` host import.
 * Standalone has no JS host, so the import leaked (`host_free_pass` excluded it)
 * even though the module still passed via a harness shim. That `__new_<Parent>`
 * was the SOLE remaining host import of the `subclass-<Parent>` conformance
 * tests — which only assert `instanceof` (both `instanceof Sub` and
 * `instanceof <Parent>` are already resolved host-free by `tryStaticInstanceOf`).
 *
 * Fix (mirroring #3238's `Object` slice): `emitStandaloneVecBuiltinConstructor`
 * registers an in-module `__new_<Parent>` returning a fresh empty native vec
 * (boxed to externref), so the module compiles host-free. This is identity-only
 * — no element kind / byteLength / `super(length)` semantics — which is safe
 * because no TypedArray/SharedArrayBuffer subclass BEHAVIOR test passes in
 * standalone today, so there is nothing length-dependent to regress.
 *
 * gc / JS-host mode is unchanged (keeps the `__new_<Parent>` host import).
 */

const TA_PARENTS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "SharedArrayBuffer",
] as const;

function moduleFor(parent: string): string {
  // SharedArrayBuffer needs a length arg; the TypedArrays accept a 0-arg super().
  const arg = parent === "SharedArrayBuffer" ? "0" : "";
  return `
    class Sub extends ${parent} {}
    class SubExplicit extends ${parent} { constructor() { super(${arg}); } }
    export function implicitSelf(): number { const s = new Sub(${arg}); return s instanceof Sub ? 1 : 0; }
    export function implicitParent(): number { const s = new Sub(${arg}); return s instanceof ${parent} ? 1 : 0; }
    export function explicitSelf(): number { const s = new SubExplicit(); return s instanceof SubExplicit ? 1 : 0; }
    export function explicitParent(): number { const s = new SubExplicit(); return s instanceof ${parent} ? 1 : 0; }
  `;
}

describe("#3239 — TypedArray/SharedArrayBuffer subclass native ctor (standalone host-free)", () => {
  for (const parent of TA_PARENTS) {
    it(`class Sub extends ${parent} — standalone: no __new_${parent} leak, instanceof holds`, async () => {
      const r = await compile(moduleFor(parent), { target: "standalone" });
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      const labels = r.imports.map((im) => `${im.module}::${im.name}`);
      // Headline: the specific host import is gone.
      expect(
        labels.filter((l) => l === `env::__new_${parent}`),
        `leaked env::__new_${parent}`,
      ).toEqual([]);
      // Blanket: standalone module must have zero env:: imports.
      expect(
        labels.filter((l) => l.startsWith("env::")),
        `unexpected env:: imports: ${labels.join(", ")}`,
      ).toEqual([]);
      // Empty import object proves zero host dependency; instanceof must hold.
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const ex = instance.exports as Record<string, () => number>;
      expect(ex.implicitSelf!()).toBe(1);
      expect(ex.implicitParent!()).toBe(1);
      expect(ex.explicitSelf!()).toBe(1);
      expect(ex.explicitParent!()).toBe(1);
    });
  }

  it("WASI target also flips Uint8Array subclass host-free", async () => {
    const r = await compile(moduleFor("Uint8Array"), { target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    expect(
      labels.filter((l) => l === "env::__new_Uint8Array"),
      "leaked env::__new_Uint8Array (WASI)",
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.implicitParent!()).toBe(1);
  });

  it("default (gc / JS-host) mode keeps the __new_<Parent> host import", async () => {
    // The native replacement is gated on standalone/WASI — gc mode must stay
    // byte-identical (still import __new_Uint8Array via the host).
    const r = await compile(moduleFor("Uint8Array"), {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    expect(labels).toContain("env::__new_Uint8Array");
  });
});
