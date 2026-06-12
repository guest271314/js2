import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #2056 — JS `%` must be the exact IEEE-754 remainder (fmod), not the lossy
// `a - trunc(a/b)*b` formula which drifts by ULPs, collapses to 0 for large
// a/b, and overflows to ±Infinity when a/b exceeds f64 range.
describe("modulo is true IEEE fmod (#2056)", () => {
  const mod = `export function mod(a: number, b: number): number { return a % b; }`;

  it("precision: small fractional operands", async () => {
    await assertEquivalent(mod, [
      { fn: "mod", args: [0.7, 0.1] },
      { fn: "mod", args: [81.3, 0.1] },
    ]);
  });

  it("large dividend / tiny divisor no longer collapse to 0", async () => {
    await assertEquivalent(mod, [
      { fn: "mod", args: [1e16, 0.0001] },
      { fn: "mod", args: [123456789.123, 0.001] },
    ]);
  });

  it("extreme ratio no longer overflows to Infinity", async () => {
    await assertEquivalent(mod, [
      { fn: "mod", args: [1e308, 1e-308] },
      { fn: "mod", args: [1e300, 1e-300] },
    ]);
  });

  it("#216 edge cases stay correct", async () => {
    await assertEquivalent(mod, [
      { fn: "mod", args: [5, Infinity] },
      { fn: "mod", args: [-0, 3] },
      { fn: "mod", args: [7, -7] },
      { fn: "mod", args: [-13.5, 4] },
      { fn: "mod", args: [Infinity, 2] },
      { fn: "mod", args: [5, 0] },
      { fn: "mod", args: [NaN, 2] },
    ]);
  });

  it("ordinary integer and mixed-sign cases", async () => {
    await assertEquivalent(mod, [
      { fn: "mod", args: [10, 3] },
      { fn: "mod", args: [-10, 3] },
      { fn: "mod", args: [10, -3] },
      { fn: "mod", args: [17.5, 4.2] },
      { fn: "mod", args: [1000000, 7] },
    ]);
  });

  it("compound %= assignment uses fmod too", async () => {
    await assertEquivalent(`export function modAssign(a: number, b: number): number { a %= b; return a; }`, [
      { fn: "modAssign", args: [1e16, 0.0001] },
      { fn: "modAssign", args: [0.7, 0.1] },
    ]);
  });
});
