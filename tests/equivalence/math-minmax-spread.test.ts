import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// §21.3.2.24/25: Math.max/min spread the iterable arguments. The generic
// SpreadElement passthrough previously unwrapped `...arr` to `arr`, coercing
// the array to NaN. (#2054)
describe("Math.max / Math.min with spread arguments (#2054)", () => {
  it("Math.max(...arr) folds the array", async () => {
    await assertEquivalent(
      `export function test(): number { const arr: number[] = [3, 9, 4]; return Math.max(...arr); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.min(...arr) folds the array", async () => {
    await assertEquivalent(
      `export function test(): number { const arr: number[] = [3, 9, 4]; return Math.min(...arr); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.max(...[]) is -Infinity", async () => {
    await assertEquivalent(`export function test(): number { const arr: number[] = []; return Math.max(...arr); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Math.min(...[]) is Infinity", async () => {
    await assertEquivalent(`export function test(): number { const arr: number[] = []; return Math.min(...arr); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("leading positional then spread: Math.max(0, ...arr)", async () => {
    await assertEquivalent(
      `export function test(): number { const arr: number[] = [3, 9, 4]; return Math.max(0, ...arr); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("trailing positional after spread: Math.max(...arr, 20)", async () => {
    await assertEquivalent(
      `export function test(): number { const arr: number[] = [3, 9, 4]; return Math.max(...arr, 20); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("positional on both sides: Math.min(0, ...arr, -5)", async () => {
    await assertEquivalent(
      `export function test(): number { const arr: number[] = [1, 2]; return Math.min(0, ...arr, -5); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("NaN element propagates: Math.max(...[3, NaN, 4])", async () => {
    await assertEquivalent(
      `export function test(): number { const arr: number[] = [3, NaN, 4]; return Math.max(...arr); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple spreads: Math.max(...a, ...b)", async () => {
    await assertEquivalent(
      `export function test(): number { const a: number[] = [1, 2]; const b: number[] = [9, 3]; return Math.max(...a, ...b); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("negative values: Math.max(...arr) with all-negative array", async () => {
    await assertEquivalent(
      `export function test(): number { const arr: number[] = [-3, -9, -4]; return Math.max(...arr); }`,
      [{ fn: "test", args: [] }],
    );
  });
});
