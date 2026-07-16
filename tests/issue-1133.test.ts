import { test, expect, describe } from "vitest";
import { compileAndRunTestSync as compileAndRun } from "./helpers/compile.js";

describe("#1133 — any-typed string equality uses content comparison, not identity", () => {
  test("'hello' === 'hello' returns true for any-typed values", async () => {
    const result = await compileAndRun(`
      let a: any = 'hello';
      let b: any = 'hello';
      export function test(): number {
        return (a === b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("'hello' === 'world' returns false for any-typed values", async () => {
    const result = await compileAndRun(`
      let a: any = 'hello';
      let b: any = 'world';
      export function test(): number {
        return (a === b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  test("'hello' == 'hello' returns true for any-typed values", async () => {
    const result = await compileAndRun(`
      let a: any = 'hello';
      let b: any = 'hello';
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("'hello' == 'world' returns false for any-typed values", async () => {
    const result = await compileAndRun(`
      let a: any = 'hello';
      let b: any = 'world';
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  test("'hello' !== 'hello' returns false for any-typed values", async () => {
    const result = await compileAndRun(`
      let a: any = 'hello';
      let b: any = 'hello';
      export function test(): number {
        return (a !== b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  test("'hello' != 'hello' returns false for any-typed values", async () => {
    const result = await compileAndRun(`
      let a: any = 'hello';
      let b: any = 'hello';
      export function test(): number {
        return (a != b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });
});
