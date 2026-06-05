// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1896 prerequisite — `__call_fn_N` / `__call_fn_method_N` argument coercion.
 *
 * A closure stored in an `any` (or handed off as a callback) is invoked via the
 * `__call_fn_<arity>` export, whose host-facing params are all `externref`. The
 * lifted closure funcref, however, declares its *reference-typed* user params as
 * `anyref` (under the native-strings backends a `string` param lowers to
 * `(ref null $AnyString)` which widens to `anyref`, NOT `externref`). The
 * dispatcher pushed the host externref arg RAW into `call_ref`, so the verifier
 * rejected the module:
 *
 *   Compiling function "__call_fn_2" failed:
 *   any.convert_extern[0] expected type externref, found ... of type anyref
 *
 * In WasmGC (`wasm:js-string`) mode the string param's funcref ValType *is*
 * externref, so the raw arg type-checked and the bug stayed hidden. The fix
 * inserts `any.convert_extern` (externref → anyref) for non-externref reference
 * params before they feed `call_ref`, in both `emitClosureCallExportN` and
 * `emitClosureMethodCallExportN`.
 */

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function compileValidateRun(src: string, target: (typeof TARGETS)[number]) {
  const r = await compile(src, { target });
  expect(r.errors ?? []).toEqual([]);
  // WebAssembly.compile throws on an invalid module — the core regression guard.
  await WebAssembly.compile(r.binary);
  return r;
}

describe("#1896 prereq: __call_fn ref-arg coercion", () => {
  // The original failing shapes: closure-into-`any`, called with ref-typed args.
  for (const target of TARGETS) {
    it(`2-arg string closure-into-any compiles+validates [${target}]`, async () => {
      await compileValidateRun(
        `const f: any = function (a: string, b: string) { return a + b; };
         export function test(): string { return f("p", "q"); }`,
        target,
      );
    });

    it(`2-arg string closure, no-op body [${target}]`, async () => {
      await compileValidateRun(
        `const f: any = function (a: string, b: string) { return a; };
         export function test(): string { return f("p", "q"); }`,
        target,
      );
    });

    it(`3-arg mixed (string,number,string) closure-into-any [${target}]`, async () => {
      await compileValidateRun(
        `const f: any = function (a: string, n: number, c: string) { return a + c; };
         export function test(): string { return f("p", 1, "q"); }`,
        target,
      );
    });

    it(`4-arg all-string closure-into-any [${target}]`, async () => {
      await compileValidateRun(
        `const f: any = function (a: string, b: string, c: string, d: string) { return a + b + c + d; };
         export function test(): string { return f("p", "q", "r", "s"); }`,
        target,
      );
    });

    // Regression-guard the shapes that already worked, so the fix stays additive.
    it(`1-arg string closure stays valid [${target}]`, async () => {
      await compileValidateRun(
        `const f: any = function (s: string) { return s + "!"; };
         export function test(): string { return f("hi"); }`,
        target,
      );
    });

    it(`2-arg number closure stays valid [${target}]`, async () => {
      await compileValidateRun(
        `const f: any = function (a: number, b: number) { return a + b; };
         export function test(): number { return f(1, 2); }`,
        target,
      );
    });
  }

  // Runtime correctness under standalone (no host imports → empty importObject).
  // The closure takes ref-typed (string) args — exercising the coercion fix —
  // but returns a number so the result is host-readable without a string-decode
  // shim (standalone returns native-string structs the JS host can't stringify).
  it("2-arg string-arg closure-into-any runs and returns derived number (standalone)", async () => {
    const r = await compileValidateRun(
      `const f: any = function (a: string, b: string): number { return a.length + b.length; };
       export function test(): number { return f("ab", "cde"); }`,
      "standalone",
    );
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const out = (instance.exports as { test: () => number }).test();
    expect(out).toBe(5); // "ab".length (2) + "cde".length (3)
  });
});
