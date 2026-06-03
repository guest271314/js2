// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1105 — String.prototype.at out-of-range index must return `undefined`,
// not the empty string `charAt` produces.
//
// Spec reference:
// - ECMA-262 §22.1.3.1 String.prototype.at: after ToIntegerOrInfinity and the
//   relative-index adjustment, "If k < 0 or k ≥ len, return undefined."
//
// In nativeStrings/standalone mode `.at()` returns a native string ref. We model
// the `undefined` result as a null AnyString ref; the strict-equality path
// (binary-ops.ts) treats a null AnyString-typed ref as undefined-equal, while
// class-instance struct refs keep `struct === undefined → false`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileNativeRuntime(source: string): Promise<Record<string, unknown>> {
  const result = await compile(source, {
    fast: true,
    nativeStrings: true,
    testRuntime: true,
    fileName: "issue-1105-at-oob.ts",
  });
  expect(result.success, result.errors.map((err) => err.message).join("\n")).toBe(true);

  const imports = buildImports(result.imports, ENV_STUB, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, unknown>;
}

describe("#1105 String.prototype.at out-of-range → undefined", () => {
  it("returns the indexed code unit for in-range positive and negative indices", async () => {
    const exports = await compileNativeRuntime(`
      export function atPos(): number {
        return "hello".at(1)!.charCodeAt(0);
      }
      export function atNeg(): number {
        return "hello".at(-1)!.charCodeAt(0);
      }
    `);
    expect((exports.atPos as () => number)()).toBe(101); // 'e'
    expect((exports.atNeg as () => number)()).toBe(111); // 'o'
  });

  it("returns undefined (null native string) for out-of-range indices", async () => {
    const exports = await compileNativeRuntime(`
      export function oobHigh(): number {
        return "hi".at(5) === undefined ? 1 : 0;
      }
      export function oobNegBig(): number {
        return "hi".at(-9) === undefined ? 1 : 0;
      }
      export function inRangeDefined(): number {
        return "hi".at(0) === undefined ? 1 : 0;
      }
      export function inRangeNeqUndefined(): number {
        return "hi".at(1) !== undefined ? 1 : 0;
      }
    `);
    expect((exports.oobHigh as () => number)()).toBe(1);
    expect((exports.oobNegBig as () => number)()).toBe(1);
    expect((exports.inRangeDefined as () => number)()).toBe(0);
    expect((exports.inRangeNeqUndefined as () => number)()).toBe(1);
  });

  it("does not change `struct === undefined` semantics for class instances", async () => {
    // Regression guard: the equality refinement is gated on the AnyString type
    // index, so a class-instance struct ref must still compare always-false.
    const exports = await compileNativeRuntime(`
      class C { x = 1; }
      export function classNeqUndefined(): number {
        const c = new C();
        return (c as unknown) === undefined ? 1 : 0;
      }
    `);
    expect((exports.classNeqUndefined as () => number)()).toBe(0);
  });
});
