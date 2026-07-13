import { describe, it, expect } from "vitest";
import { compileAndRunBuildImports as compileAndRun } from "./helpers/compile.js";

describe("Math.min / Math.max", () => {
  it("Math.min with 2 args", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(3, 7); }
    `);
    expect(e.test()).toBe(3);
  });

  it("Math.max with 2 args", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.max(3, 7); }
    `);
    expect(e.test()).toBe(7);
  });

  it("Math.min with 3 args", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(5, 2, 8); }
    `);
    expect(e.test()).toBe(2);
  });

  it("Math.max with 4 args", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.max(1, 9, 3, 7); }
    `);
    expect(e.test()).toBe(9);
  });

  it("Math.min with 1 arg", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(42); }
    `);
    expect(e.test()).toBe(42);
  });

  it("Math.min with NaN propagates", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(1, NaN, 3); }
    `);
    expect(e.test()).toBeNaN();
  });

  it("Math.max with negative values", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.max(-5, -2, -8); }
    `);
    expect(e.test()).toBe(-2);
  });

  it("Math.min with no args returns Infinity", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(); }
    `);
    expect(e.test()).toBe(Infinity);
  });

  it("Math.max with no args returns -Infinity", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.max(); }
    `);
    expect(e.test()).toBe(-Infinity);
  });
});
