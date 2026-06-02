// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1553d — route the array *declaration* destructuring paths
 * (`compileArrayDestructuring` typed vec/tuple body and the externref twin
 * `compileExternrefArrayDestructuringDecl`) through the shared
 * `destructureParamArray` helper in decl mode.
 *
 * The legacy decl-side functions had drifted from the function-parameter
 * helper. Delegating fixes:
 *   - root-cause 6: `let [a, ...rest] = [1,2,3,4]` allocated `rest` twice and
 *     read back a stale slot, producing `[1, 0]`. The helper uses a single
 *     localMap lookup → `[1, [2,3,4]]`.
 *   - iterator-close / throw-propagation on element defaults.
 *
 * It also pins two bugs uncovered while delegating (both in the shared helper,
 * latent until the decl path exercised them):
 *   - A function-call / global-referencing element default (`let [x = f()]`,
 *     `let [x = g]`) corrupted global/late-import indices because the helper's
 *     null-guard swapped into a `destructInstrs` buffer that was invisible to
 *     `fixupModuleGlobalIndices` / `shiftLateImportIndices`.
 *   - `let [x] = [null]` unboxed a genuine `null` to `0` when the TS-narrowed
 *     binding type was numeric; the retired externref-array path bound the
 *     element local as externref, preserving the null identity.
 *
 * Spec basis: ECMA-262 §13.15.5.2 ArrayAssignmentPattern /
 * §8.4.2 GetIterator — defaults fire only on `undefined` (not `null`).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1553d — array decl destructuring via shared helper", () => {
  it("vec rest binds a real array, not a stale slot (root-cause 6)", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let [a, ...rest] = [1, 2, 3, 4];
        return a * 1000 + rest.length * 100 + rest[0] * 10 + rest[2];
      }
    `);
    // a=1, rest=[2,3,4]: 1000 + 300 + 20 + 4
    expect(exports.f()).toBe(1324);
  });

  it("rest-only binding collects all elements", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        const [...r] = [5, 6, 7];
        return r.length * 100 + r[0] * 10 + r[2];
      }
    `);
    expect(exports.f()).toBe(357);
  });

  it("elision skips holes and binds later positions", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let [, x, , y] = [1, 2, 3, 4];
        return x * 10 + y;
      }
    `);
    expect(exports.f()).toBe(24);
  });

  it("nested array pattern binds inner elements", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let [[a, b], c] = [[1, 2], 3];
        return a * 100 + b * 10 + c;
      }
    `);
    expect(exports.f()).toBe(123);
  });

  it("element default fires when slot is missing", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let [a, b = 5] = [7];
        return a * 10 + b;
      }
    `);
    expect(exports.f()).toBe(75);
  });

  it("element default is skipped when slot has a real value", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let [a = 9] = [3];
        return a;
      }
    `);
    expect(exports.f()).toBe(3);
  });

  it("function-call default reads a module global without index corruption", async () => {
    // Regression: the default `bump()` mutates a module global. Compiling it
    // inside the null-guard's detached buffer used to corrupt the global /
    // late-import index, re-pointing an f64 global at an externref import.
    const exports = await compileToWasm(`
      let bumped = 0;
      function bump(): number { bumped++; return 42; }
      export function f(): number {
        let [x = bump()] = [1, 2, 3];
        return x === 1 && bumped === 0 ? 1 : 0;
      }
    `);
    expect(exports.f()).toBe(1);
  });

  it("element default that references a module global compiles correctly", async () => {
    const exports = await compileToWasm(`
      let g = 5;
      export function f(): number {
        let [x = g] = [1, 2, 3];
        return x;
      }
    `);
    expect(exports.f()).toBe(1);
  });

  it("[null] preserves null and does not fire the default", async () => {
    // null is not undefined: the default must NOT fire, and the bound value
    // must remain null (not be unboxed to 0 by a numeric coercion).
    const exports = await compileToWasm(`
      export function f(): number {
        const arr = [null];
        let [x = 99] = arr;
        return x === null ? 1 : 0;
      }
    `);
    expect(exports.f()).toBe(1);
  });
});
