// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3264 (epic #3182) — god-file split smoke test.
//
// The `Array.prototype.<method>.call(arrayLike, …)` prototype-borrow subsystem
// was extracted VERBATIM from src/codegen/array-methods.ts into the new sibling
// module src/codegen/array-prototype-borrow.ts (compileArrayPrototypeCall +
// compileArrayLikePrototypeCall and the specialised borrow impls). The move is
// byte-identity IDENTICAL (prove-emit-identity, 39/39 gc/standalone/wasi emits),
// so this test is a permanent guard that the extracted dispatch still compiles
// and runs — exercising both the specialised entries (indexOf/includes/every/
// some/forEach) and the generic array-like loop (find/map).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compilation failed: ${r.errors[0]?.message ?? "unknown error"}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => number)();
}

describe("#3264 — Array.prototype-borrow subsystem (extracted to array-prototype-borrow.ts)", () => {
  it("compileArrayPrototypeIndexOf: indexOf.call finds the element index", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const a: number[] = [10, 20, 30]; return Array.prototype.indexOf.call(a, 20); }`,
      ),
    ).toBe(1);
  });

  it("compileArrayPrototypeIncludes: includes.call reports membership", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const a: number[] = [1, 2, 3]; return Array.prototype.includes.call(a, 2) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("compileArrayPrototypeEvery: every.call over an all-satisfying array is true", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const a: number[] = [2, 4, 6]; return Array.prototype.every.call(a, (x: number) => x % 2 === 0) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("compileArrayPrototypeSome: some.call finds a matching element", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const a: number[] = [1, 3, 5]; return Array.prototype.some.call(a, (x: number) => x === 3) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("compileArrayPrototypeForEach: forEach.call visits every element", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const a: number[] = [1, 2, 3]; let s = 0; Array.prototype.forEach.call(a, (x: number) => { s += x; }); return s; }`,
      ),
    ).toBe(6);
  });

  it("compileArrayLikePrototypeCall (generic): find.call returns the first match", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const a: number[] = [5, 6, 7]; return Array.prototype.find.call(a, (x: number) => x === 6) as number; }`,
      ),
    ).toBe(6);
  });

  it("compileArrayLikePrototypeCall (generic): map.call transforms each element", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const a: number[] = [1, 2, 3]; const b: number[] = Array.prototype.map.call(a, (x: number) => x * 10) as number[]; return b[1]; }`,
      ),
    ).toBe(20);
  });
});
