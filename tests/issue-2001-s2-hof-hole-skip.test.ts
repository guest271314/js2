// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2001 S2 — HOF hole visit-skip on the dense WasmGC vec.
//
// The ES `HasProperty(O, ‹k›) is false ⇒ skip` array methods must NOT run their
// per-iteration work for an absent index (a `$Hole` slot in an `any[]`/untyped
// externref vec, per S1). This slice adds the skip gate to the dense-vec loop
// drivers of: forEach, filter, some, every, reduce, reduceRight, indexOf,
// lastIndexOf. reduce/reduceRight also seek the first/last PRESENT index for
// the no-initial-value seed.
//
// NOT skip methods (they use `[[Get]]`, ES6): find, findIndex, includes — they
// VISIT holes as `undefined` (the S1 read map), unchanged here.
//
// DEFERRED: `map`'s result-hole (a numeric-callback result vec is f64 and can't
// hold the sentinel, and TS types the result `number[]` so downstream consumers
// mis-read a forced-externref result — a separate slice). map still VISITS.
//
// Scope: `any[]` / untyped (externref element) only. Typed `number[]` (f64
// element) keeps materializing `0` at the hole and its HOFs keep visiting —
// accepted divergence (a hole is unrepresentable in the source type).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

async function runStandalone(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true, target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2001 S2 — HOF hole visit-skip (any[] / externref vecs)", () => {
  describe("forEach", () => {
    it("does not visit the hole ([1,,3] → 2 calls)", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [1,,3]; let c=0; a.forEach(()=>{c++;}); return c; }`,
        ),
      ).toBe(2);
    });
    it("index-grow gap is still visited (S3 boundary — gap is filled, not a $Hole)", async () => {
      // b[5]=9 fills [1,5) with the element default (S7 fills undefined, not
      // $Hole) — those become present indices. Documenting the S3 boundary: the
      // grow-gap is NOT a literal hole, so forEach visits it. Count is 6.
      expect(
        await run(
          `export function run(): number { const b: any[] = [1]; b[5]=9; let c=0; b.forEach(()=>{c++;}); return c; }`,
        ),
      ).toBe(6);
    });
  });

  describe("filter", () => {
    it("omits holes ([1,,3].filter(()=>true).length === 2)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1,,3]; return a.filter(()=>true).length; }`),
      ).toBe(2);
    });
    it("a real undefined element is kept", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [1,undefined,3]; return a.filter((x)=>x===undefined).length; }`,
        ),
      ).toBe(1);
    });
  });

  describe("some / every", () => {
    it("some skips the hole ([1,,3].some(x=>x===undefined) === false)", async () => {
      expect(
        await run(`export function run(): boolean { const a: any[] = [1,,3]; return a.some((x)=>x===undefined); }`),
      ).toBe(0);
    });
    it("some still sees a real undefined element", async () => {
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1,undefined,3]; return a.some((x)=>x===undefined); }`,
        ),
      ).toBe(1);
    });
    it("every: a hole never falsifies ([1,,3].every(x=>x!==undefined) === true)", async () => {
      expect(
        await run(`export function run(): boolean { const a: any[] = [1,,3]; return a.every((x)=>x!==undefined); }`),
      ).toBe(1);
    });
    it("every still falsifies on a real undefined", async () => {
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1,undefined,3]; return a.every((x)=>x!==undefined); }`,
        ),
      ).toBe(0);
    });
  });

  describe("indexOf / lastIndexOf", () => {
    it("indexOf skips a hole ([1,,3].indexOf(undefined) === -1)", async () => {
      expect(await run(`export function run(): number { const a: any[] = [1,,3]; return a.indexOf(undefined); }`)).toBe(
        -1,
      );
    });
    it("indexOf still matches a real undefined element", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1,undefined,3]; return a.indexOf(undefined); }`),
      ).toBe(1);
    });
    it("indexOf of a present value is unchanged around a hole", async () => {
      expect(await run(`export function run(): number { const a: any[] = [1,,3]; return a.indexOf(3); }`)).toBe(2);
    });
    it("lastIndexOf skips a hole ([1,,3].lastIndexOf(undefined) === -1)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1,,3]; return a.lastIndexOf(undefined); }`),
      ).toBe(-1);
    });
    it("lastIndexOf still matches a real undefined", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [1,undefined,3]; return a.lastIndexOf(undefined); }`,
        ),
      ).toBe(1);
    });
    it("includes VISITS a hole (Get semantics) — includes(undefined) === true", async () => {
      expect(
        await run(`export function run(): boolean { const a: any[] = [1,,3]; return a.includes(undefined); }`),
      ).toBe(1);
    });
  });

  describe("reduce / reduceRight", () => {
    it("reduce skips holes ([5,,,2].reduce((a,b)=>a+b) === 7)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [5,,,2]; return a.reduce((x,y)=>x+y); }`),
      ).toBe(7);
    });
    it("reduce no-initial seed seeks the first PRESENT index ([,5,3] → 8)", async () => {
      expect(await run(`export function run(): number { const a: any[] = [,5,3]; return a.reduce((x,y)=>x+y); }`)).toBe(
        8,
      );
    });
    it("reduce of an all-hole array with no initial value throws (Reduce of empty array)", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [,,]; try { return a.reduce((x,y)=>x+y); } catch(e) { return 42; } }`,
        ),
      ).toBe(42);
    });
    it("reduce with an initial value folds present elements only ([1,,3], 0 → 4)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1,,3]; return a.reduce((x,y)=>x+y, 0); }`),
      ).toBe(4);
    });
    it("reduceRight skips holes ([5,,,2].reduceRight((a,b)=>a+b) === 7)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [5,,,2]; return a.reduceRight((x,y)=>x+y); }`),
      ).toBe(7);
    });
    it("reduceRight no-initial seed seeks the last PRESENT index ([3,5,,] → 8)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [3,5,,]; return a.reduceRight((x,y)=>x+y); }`),
      ).toBe(8);
    });
  });

  describe("visit methods (find/findIndex) still visit holes — NOT skipped", () => {
    it("find visits the hole as undefined", async () => {
      expect(
        await run(`export function run(): string { const a: any[] = [,5]; return typeof a.find((x)=>x===undefined); }`),
      ).toBe("undefined");
    });
    it("findIndex visits the hole (returns 0)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [,5]; return a.findIndex((x)=>x===undefined); }`),
      ).toBe(0);
    });
  });

  describe("typed number[] guard — accepted divergence, byte path unchanged", () => {
    it("number[] forEach still visits the (materialized) hole ([1,,3] → 3 calls)", async () => {
      expect(
        await run(
          `export function run(): number { const a: number[] = [1,,3]; let c=0; a.forEach(()=>{c++;}); return c; }`,
        ),
      ).toBe(3);
    });
    it("number[] indexOf of a present value is unaffected (byte-identical typed path)", async () => {
      // The typed f64 hole is the sNaN default sentinel (not 0), and the gate is
      // externref-only, so the f64 indexOf is byte-identical to main: a present
      // value is found, and `indexOf(0)` does not match the sentinel slot.
      expect(await run(`export function run(): number { const a: number[] = [1,,3]; return a.indexOf(3); }`)).toBe(2);
      expect(await run(`export function run(): number { const a: number[] = [1,,3]; return a.indexOf(0); }`)).toBe(-1);
    });
  });

  describe("standalone parity (no host import — $Hole is pure WasmGC)", () => {
    it("forEach skip works standalone", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [1,,3]; let c=0; a.forEach(()=>{c++;}); return c; }`,
        ),
      ).toBe(2);
    });
    it("reduce skip + seed seek works standalone", async () => {
      expect(
        await runStandalone(`export function run(): number { const a: any[] = [5,,,2]; return a.reduce((x,y)=>x+y); }`),
      ).toBe(7);
    });
  });
});
