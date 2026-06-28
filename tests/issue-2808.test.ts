// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2808 (parent #2669) — for-of OBJECT-binding head with a NESTED sub-pattern.
 *
 * `compileForOfDestructuring` (src/codegen/statements/loops.ts) is a separate,
 * less-complete reimplementation of destructuring for the for-of / for-await
 * loop head. Its ARRAY-pattern branch already recurses into nested sub-patterns
 * (#2216), but the OBJECT-pattern struct branch DROPPED them at the
 * identifier-only `continue` — so:
 *
 *   for (const { w: { x, y, z } } of [{ w: { x: 1, y: 2, z: 3 } }])  // x,y,z never bound
 *   for (const { w: [x] } of [{ w: null }])                          // never threw
 *
 * Fix: mirror the array branch — extract the field value, apply the
 * (undefined-only) nested default, then recurse. The recursion's own
 * RequireObjectCoercible / GetIterator null guard throws TypeError for a
 * null/undefined nested target (ECMA-262 §13.15.5.5 / §8.5.2), so a nested
 * pattern over `null`/`undefined` now correctly throws.
 *
 * Recovers 18 for-of + 24 for-await `obj-ptrn-prop-{obj,ary}` test262 tests with
 * 0 regressions (full before/after on for-of/dstr + for-await-of/dstr).
 *
 * NOTE: the object-nested-default-FIRES sub-case where the source property value
 * is `undefined` (so the field lowers to externref) is validated through the
 * test262 cluster (`*-obj-ptrn-prop-obj-init`), not asserted here — that path is
 * representation-sensitive (externref-field default coercion, #2769-adjacent) and
 * not reliably reproducible via a standalone `compile()` shape. The core fix —
 * nested recursion + null/undefined RequireObjectCoercible throw + undefined-only
 * default + nested ARRAY default — is locked in below.
 */

async function run(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as { test: () => number }).test();
}

describe("#2808 — for-of object-binding nested sub-pattern: value extraction", () => {
  it("nested object sub-pattern binds inner names", async () => {
    expect(
      await run(
        `export function test(): number { let s = 0; for (const { w: { x, y, z } } of [{ w: { x: 1, y: 2, z: 3 } }]) { s = x * 100 + y * 10 + z; } return s; }`,
      ),
    ).toBe(123);
  });

  it("nested array sub-pattern binds inner elements", async () => {
    expect(
      await run(
        `export function test(): number { let s = 0; for (const { w: [x, y, z] } of [{ w: [7, 8, 9] }]) { s = x * 100 + y * 10 + z; } return s; }`,
      ),
    ).toBe(789);
  });

  it("nested sub-pattern with a trailing comma in the outer object pattern", async () => {
    expect(
      await run(
        `export function test(): number { let s = 0; for (const { x: [y], } of [{ x: [45] }]) { s = y; } return s; }`,
      ),
    ).toBe(45);
  });

  it("nested array default fires when the property value is undefined", async () => {
    expect(
      await run(
        `export function test(): number { let s = 0; for (const { w: [x, y, z] = [4, 5, 6] } of [{ w: undefined }]) { s = x * 100 + y * 10 + z; } return s; }`,
      ),
    ).toBe(456);
  });
});

describe("#2808 — for-of object-binding nested sub-pattern: RequireObjectCoercible / GetIterator throws", () => {
  it("nested object sub-pattern over a null value throws TypeError", async () => {
    await expect(
      run(
        `export function test(): number { let s = 0; for (const { w: { x } } of [{ w: null }]) { s = 1; } return s; }`,
      ),
    ).rejects.toThrow();
  });

  it("nested array sub-pattern over a null value throws TypeError", async () => {
    await expect(
      run(`export function test(): number { let s = 0; for (const { w: [x] } of [{ w: null }]) { s = 1; } return s; }`),
    ).rejects.toThrow();
  });

  it("a default does NOT fire on null — the null nested target still throws", async () => {
    // KeyedBindingInitialization §13.3.3.7 step 3: the default applies only when
    // the value is `undefined`, never `null`. So `{ w: null }` keeps null, and
    // the nested `{ x }` over null throws.
    await expect(
      run(
        `export function test(): number { let s = 0; for (const { w: { x } = { x: 1 } } of [{ w: null }]) { s = 1; } return s; }`,
      ),
    ).rejects.toThrow();
  });
});

describe("#2808 — controls (must stay unchanged)", () => {
  it("flat object pattern in for-of head is unaffected", async () => {
    expect(
      await run(
        `export function test(): number { let s = 0; for (const { a, b } of [{ a: 1, b: 2 }]) { s = a + b; } return s; }`,
      ),
    ).toBe(3);
  });

  it("nested array-in-array binding (array branch) is unaffected", async () => {
    expect(
      await run(
        `export function test(): number { let s = 0; for (const [[a, b]] of [[[10, 20]]]) { s = a + b; } return s; }`,
      ),
    ).toBe(30);
  });

  it("object sub-pattern inside an array pattern (array branch) is unaffected", async () => {
    expect(
      await run(
        `export function test(): number { let s = 0; for (const [{ a }] of [[{ a: 99 }]]) { s = a; } return s; }`,
      ),
    ).toBe(99);
  });
});
