// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2029 — standalone primitive-wrapper SUBCLASS emitted invalid Wasm.
 *
 * The 497-test `u32 out of range: -1` emit-crash headline is fixed. This is the
 * residual in-lane defect: `class N extends Number {}` / `extends Boolean {}`
 * under `--target standalone` emitted invalid Wasm. Number/Boolean are in
 * `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`, so `super()`/`new Sub()` lowered to
 * `call $__new_Number`/`$__new_Boolean` — but those standalone internals take an
 * **f64** arg while the synthetic `<Class>_new` forwarder passes its externref
 * local, so the module failed to validate (`N_new: call param types must
 * match`) and died at instantiate.
 *
 * Fix (minimum-viable, mirrors the #2620 native-collection refusal): refuse the
 * Number/Boolean standalone subclass loudly at compile time (clean located CE,
 * never invalid Wasm — the #1888 dual-mode invariant). Native wrapper-box
 * subclass construction is a deferred value-rep follow-up.
 *
 * `String` is deliberately NOT refused: its standalone
 * `__new_String(externref)->externref` matches the externref forwarder, so
 * `class S extends String {}` already compiles, instantiates with an empty
 * import object, and answers `new S() instanceof S` → true standalone.
 *
 * gc/host mode is untouched — the guard is `nativeStrings`-only and the
 * externClass host path handles the subclass there.
 */

describe("#2029 primitive-wrapper subclass standalone", () => {
  for (const parent of ["Number", "Boolean"] as const) {
    it(`refuses 'class N extends ${parent}' loudly under --target standalone (no invalid Wasm)`, async () => {
      const src = `class N extends ${parent} {}\nconst n = new N();\n`;
      const r = await compile(src, { target: "standalone" });
      // Clean compile-time refusal — never a poisoned binary.
      expect(r.success, `expected a refusal, but compile succeeded for extends ${parent}`).toBe(false);
      const msg = r.errors.map((e) => e.message).join("\n");
      expect(msg).toContain(`'class N extends ${parent}'`);
      expect(msg).toContain("--target standalone");
      expect(msg).toContain("#2029");
    });

    it(`refuses 'class N extends ${parent}' loudly under --target wasi`, async () => {
      const src = `class N extends ${parent} {}\nconst n = new N();\n`;
      const r = await compile(src, { target: "wasi" });
      expect(r.success, `expected a refusal, but compile succeeded for extends ${parent} (wasi)`).toBe(false);
      const msg = r.errors.map((e) => e.message).join("\n");
      expect(msg).toContain(`'class N extends ${parent}'`);
    });

    it(`still COMPILES 'class N extends ${parent}' in default (gc / JS-host) mode`, async () => {
      // The refusal guard is nativeStrings-only — gc mode keeps the existing
      // externref-backed host path, which compiles fine.
      const src = `class N extends ${parent} {}\nexport function test(): boolean { const n = new N(); return n instanceof N; }\n`;
      const r = await compile(src, {});
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    });
  }

  it("does NOT refuse 'class S extends String' standalone — it already works", async () => {
    // String's __new_String(externref)->externref matches the forwarder, so the
    // subclass compiles, instantiates with no host imports, and `instanceof`
    // works. Refusing it would regress a working standalone case.
    const src = `class S extends String {}\nexport function test(): number { const s = new S(); return s instanceof S ? 1 : 0; }\n`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    expect(
      labels.filter((l) => l.startsWith("env::")),
      `unexpected env:: imports: ${labels.join(", ")}`,
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.test!()).toBe(1);
  });
});
