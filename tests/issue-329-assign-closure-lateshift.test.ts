// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #329 — late-import func-index-shift for a function expression assigned to an
 * `any` binding via a *separate assignment* (not an initializer).
 *
 * `let g: any; g = function () {...}; g()` baked the closure-wrapper call target
 * before the native-string helpers (`__str_flatten` / `__str_copy_tree`) were
 * appended/shifted, so under `--target standalone` the module failed validation:
 *
 *   Compiling function "__str_flatten" failed:
 *   call[0] expected type (ref null 5), found i32.const of type i32
 *
 * The *initializer* forms (`const f: any = fn` / `let f: any = fn`) were already
 * fixed (#1839/#1677/#1470); only the assignment-expression path remained.
 */

const initOk = `const f: any = function () { return 42; };
export function test(): number { return f(); }`;

const assignBug = `let g: any; g = function () { return 42; };
export function test(): number { return g(); }`;

const assignStr = `let g: any; g = function () { return "ab".length; };
export function test(): number { return g(); }`;

async function compileValidate(src: string, target: "standalone" | "wasi" | "gc") {
  const r = await compile(src, { target });
  expect(r.errors ?? []).toEqual([]);
  await WebAssembly.compile(r.binary); // throws on the stale-funcIdx invalid wasm
  return r;
}

describe("#329 assignment-form closure late-shift", () => {
  for (const target of ["standalone", "wasi", "gc"] as const) {
    it(`initializer form stays valid [${target}]`, async () => {
      await compileValidate(initOk, target);
    });
    it(`assignment form compiles + validates [${target}]`, async () => {
      await compileValidate(assignBug, target);
    });
    it(`assignment form with string body [${target}]`, async () => {
      await compileValidate(assignStr, target);
    });
  }

  it("assignment-form closure runs and returns 42 (standalone)", async () => {
    const r = await compileValidate(assignBug, "standalone");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(42);
  });
});
