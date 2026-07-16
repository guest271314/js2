import { describe, test, expect } from "vitest";
import { compileAndRunGetResult as compileAndRun } from "./helpers/compile.js";

/**
 * Issue #1594B — class name in its own `extends` expression is in the TDZ.
 * Per ECMA-262 §15.7.1 ClassDefinitionEvaluation, the class-name binding is
 * installed in the class's inner scope only AFTER the `extends` clause is
 * evaluated. Referencing the class name inside `extends` must throw
 * ReferenceError: `class x extends x {}`.
 */

describe("class name in own extends expression is TDZ (#1594B)", () => {
  test("class x extends x {} throws ReferenceError", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      export function getResult(): number {
        let caught = 0;
        try {
          class x extends x {}
        } catch (e) {
          caught = 1;
        }
        return caught;
      }
    `);
    expect(val).toBe(1);
  });

  test("grouped: class x extends (x) {} throws ReferenceError", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      export function getResult(): number {
        let caught = 0;
        try {
          class x extends (x) {}
        } catch (e) {
          caught = 1;
        }
        return caught;
      }
    `);
    expect(val).toBe(1);
  });

  test("class referencing its own name in a member-access extends throws", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      export function getResult(): number {
        let caught = 0;
        try {
          class x extends x.foo {}
        } catch (e) {
          caught = 1;
        }
        return caught;
      }
    `);
    expect(val).toBe(1);
  });

  test("class expression: (class x extends x {}) throws ReferenceError", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      export function getResult(): number {
        let caught = 0;
        try {
          const C = (class x extends x {});
        } catch (e) {
          caught = 1;
        }
        return caught;
      }
    `);
    expect(val).toBe(1);
  });

  test("extends an unrelated identifier still compiles (no false positive)", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      class Base { getV(): number { return 7; } }
      export function getResult(): number {
        class Derived extends Base {}
        const d = new Derived();
        return d.getV();
      }
    `);
    expect(val).toBe(7);
  });
});
