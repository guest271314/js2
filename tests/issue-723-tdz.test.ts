import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileAndRunGetResult as compileAndRun } from "./helpers/compile.js";

/**
 * Issue #723 — TDZ (Temporal Dead Zone) runtime enforcement for let/const.
 * When a let/const variable is accessed before its declaration runs,
 * a ReferenceError should be thrown at runtime.
 */

describe("TDZ runtime enforcement (#723)", () => {
  test("module-level: reading let before declaration throws ReferenceError", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      function readX(): number { return x; }
      let caught = false;
      try { readX(); } catch (e) { caught = true; }
      let x: number = 42;
      export function getResult(): number { return caught ? 1 : 0; }
    `);
    expect(val).toBe(1);
  });

  test("module-level: let without initializer still ends TDZ", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      function readX(): number { return x; }
      let caught = false;
      try { readX(); } catch (e) { caught = true; }
      let x: number;
      export function getResult(): number { return caught ? 1 : 0; }
    `);
    expect(val).toBe(1);
  });

  test("module-level: const before declaration throws ReferenceError", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      function readX(): number { return x; }
      let caught = false;
      try { readX(); } catch (e) { caught = true; }
      const x: number = 99;
      export function getResult(): number { return caught ? 1 : 0; }
    `);
    expect(val).toBe(1);
  });

  test("module-level: var has NO TDZ (hoisted)", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      function readX(): number { return x; }
      let caught = false;
      try { readX(); } catch (e) { caught = true; }
      var x: number = 42;
      export function getResult(): number { return caught ? 1 : 0; }
    `);
    // var is hoisted, so readX() should NOT throw
    expect(val).toBe(0);
  });

  test("module-level: after declaration, variable is accessible", { timeout: 15000 }, async () => {
    const val = await compileAndRun(`
      let x: number = 42;
      function readX(): number { return x; }
      export function getResult(): number { return readX(); }
    `);
    expect(val).toBe(42);
  });

  test("TDZ flag globals are present in WAT output", { timeout: 15000 }, async () => {
    const result = await compile(`
      export function f(): number { return x; }
      let x: number = 1;
    `);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__tdz_x");
  });

  test("no TDZ flag for var declarations", { timeout: 15000 }, async () => {
    const result = await compile(`
      export function f(): number { return x; }
      var x: number = 1;
    `);
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("__tdz_x");
  });
});
