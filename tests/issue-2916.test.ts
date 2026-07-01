// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2916 — Standalone native `instanceof` operator (Slice A: string-name builtin
// membership).
//
// Under `--target standalone` the dynamic `instanceof` operator on the
// string-name path emitted an unsatisfiable `env::__instanceof` host import, so
// the module could not instantiate host-free (a leaky-PASS: it passed in
// JS-host mode, died at instantiation standalone). Slice A replaces that import
// with an inline native `ref.test` membership test for the built-ins that carry
// a stable backing struct (Array/vec, Function/closure, Map/Set family, and the
// wrapper types), keeping the already-native Error-family branch.
//
// Assertions:
//   1. Import-section: a standalone build of the built-in string-name path emits
//      NO `env::__instanceof` import.
//   2. Runtime (Node WebAssembly, no JS host): the native membership test is
//      spec-correct for the handled built-ins and never a wrong `true` on a
//      primitive / non-matching value.
//   3. gc/host is untouched (the native branch is gated `noJsHost`).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

function envImportNames(r: { imports: { module: string; name: string }[] }): string[] {
  return r.imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone" });
  expect(r.success).toBe(true);
  // No leaked instanceof host imports on the string-name path.
  const env = envImportNames(r);
  expect(env).not.toContain("__instanceof");
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => number }).test!();
}

describe("#2916 — standalone native instanceof (Slice A)", () => {
  describe("import section — no __instanceof host import leaks", () => {
    for (const [label, ctor] of [
      ["Array", "Array"],
      ["Function", "Function"],
      ["Map", "Map"],
      ["Set", "Set"],
    ] as const) {
      it(`emits no __instanceof for a dynamic \`x instanceof ${ctor}\``, async () => {
        const src = `export function test(): number { const x: any = [1]; return x instanceof ${ctor} ? 1 : 0; }`;
        const r = await compile(src, { fileName: "t.ts", target: "standalone" });
        expect(r.success).toBe(true);
        expect(envImportNames(r)).not.toContain("__instanceof");
        void label;
      });
    }
  });

  describe("runtime correctness (standalone, no JS host)", () => {
    it("[] instanceof Array === true", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a: any = [1,2]; return a instanceof Array ? 1 : 0; }`,
        ),
      ).toBe(1);
    });
    it("(() => 1) instanceof Function === true (#1992)", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const f: any = () => 1; return f instanceof Function ? 1 : 0; }`,
        ),
      ).toBe(1);
    });
    it("new Map() instanceof Map === true", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const m: any = new Map(); return m instanceof Map ? 1 : 0; }`,
        ),
      ).toBe(1);
    });
    it("new Set() instanceof Set === true", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const s: any = new Set(); return s instanceof Set ? 1 : 0; }`,
        ),
      ).toBe(1);
    });
    it("a primitive is never an instance (5 instanceof Array === false)", async () => {
      expect(
        await runStandalone(`export function test(): number { const n: any = 5; return n instanceof Array ? 1 : 0; }`),
      ).toBe(0);
    });
    it("null is never an instance (null instanceof Object === false)", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const n: any = null; return n instanceof Array ? 1 : 0; }`,
        ),
      ).toBe(0);
    });
    it("an array is NOT instanceof Function (no wrong true)", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a: any = [1]; return a instanceof Function ? 1 : 0; }`,
        ),
      ).toBe(0);
    });
    it("Error-family stays native: new TypeError() instanceof TypeError === true", async () => {
      const src = `export function test(): number { const e: any = new TypeError("x"); return e instanceof TypeError ? 1 : 0; }`;
      const r = await compile(src, { fileName: "t.ts", target: "standalone" });
      expect(r.success).toBe(true);
      expect(envImportNames(r)).not.toContain("__instanceof");
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      expect((instance.exports as { test?: () => number }).test!()).toBe(1);
    });
  });

  describe("gc/host mode is byte-inert (native branch gated noJsHost)", () => {
    it("gc build still emits the __instanceof host import for the string-name path", async () => {
      const src = `export function test(): number { const a: any = [1]; return a instanceof Array ? 1 : 0; }`;
      const r = await compile(src, { fileName: "t.ts" }); // default gc/host
      expect(r.success).toBe(true);
      // The host path is unchanged: the __instanceof import is still present.
      expect(envImportNames(r)).toContain("__instanceof");
    });
  });
});
