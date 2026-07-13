// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3206 — Standalone: Array.from(source, mapFn) native map path.
//
// Under `--target standalone` the 2-arg `Array.from(source, mapFn)` form used to
// fall through to the host fallback in expressions/calls.ts, emitting the
// unsatisfiable `env.__make_callback` + `env.__array_from` imports (module fails
// to instantiate host-free). The fix composes two existing native helpers
// (`__array_from_iter_n` + `__hof_map`) so the mapFn arm is host-free.
//
// Spec: ECMA-262 §23.1.2.1 Array.from(items, mapFn, thisArg).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Host-bridge imports that MUST NOT appear in a standalone Array.from(_, mapFn).
function leakedHostImports(imports: Array<{ module: string; name: string }>): string[] {
  return imports
    .filter((imp) => imp.module === "env" && (imp.name === "__make_callback" || imp.name === "__array_from"))
    .map((imp) => imp.name);
}

async function compileStandalone(source: string) {
  const result = await compile(source, { target: "standalone", fileName: "issue-3206.ts" });
  expect(result.success, result.errors.map((err) => err.message).join("\n")).toBe(true);
  return result;
}

async function runStandalone(source: string, fn: string): Promise<unknown> {
  const result = await compileStandalone(source);
  // The mapFn arm must not leak the host bridge under standalone.
  expect(leakedHostImports(result.imports)).toEqual([]);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#3206 standalone Array.from(source, mapFn) native map path", () => {
  it("array source with mapFn is host-free and correct", async () => {
    // Array.from([5,6,7], v => v*2) => [10,12,14]; 10+12+14 = 36.
    const value = await runStandalone(
      `export function test(): number {
         const a = Array.from([5, 6, 7], (v: number) => v * 2);
         return a[0] + a[1] + a[2];
       }`,
      "test",
    );
    expect(value).toBe(36);
  });

  it("array-like {length} source with (value,index) mapFn is host-free and correct", async () => {
    // Array.from({length:3}, (_,i) => i) => [0,1,2]; 0*100 + 1*10 + 2 = 12.
    const value = await runStandalone(
      `export function test(): number {
         const a = Array.from({ length: 3 }, (_: unknown, i: number) => i);
         return a[0] * 100 + a[1] * 10 + a[2];
       }`,
      "test",
    );
    expect(value).toBe(12);
  });

  it("identifier-held mapFn is host-free and correct", async () => {
    // Array.from([1,2,3], double) => [2,4,6]; 2+4+6 = 12.
    const value = await runStandalone(
      `function double(v: number): number { return v * 2; }
       export function test(): number {
         const a = Array.from([1, 2, 3], double);
         return a[0] + a[1] + a[2];
       }`,
      "test",
    );
    expect(value).toBe(12);
  });
});
