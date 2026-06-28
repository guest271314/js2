import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #2757 (partial) — clamp the vec-rest length in array assignment-destructuring.
//
// In `[a, b, ...r] = src` the rest array is sized `src.length - i` where `i` is
// the rest element's index (the count of preceding pattern elements). When the
// source vec has FEWER elements than that prefix (`src.length < i`), the count is
// NEGATIVE; `array.new_default` reads the size operand as UNSIGNED → it requests
// a ~4-billion-element array → "requested new array is too large" trap.
// `src/codegen/expressions/assignment.ts` now floors the count at 0, so a
// short/empty source yields an EMPTY rest array instead of trapping.
//
// NOTE: this is the partial (trap-hardening) slice of #2757. The remaining work
// (object-pattern rest target `[...{0:x,length}] = vals`, and the OOB non-rest
// element → `undefined` value, and tuple-source rest) is tracked in the #2757
// issue file. These tests pin ONLY the clamp's contract.
describe("#2757 array assignment-destructuring rest-length clamp", () => {
  it("does not trap when the vec source is shorter than the non-rest prefix", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let src: any[] = [1];
        let a: any, b: any, r: any;
        [a, b, ...r] = src;        // prefix(2) > src.length(1): rest count -1 pre-clamp
        if (a !== 1) return 1;      // the present element still reads
        if (!Array.isArray(r)) return 2;
        if (r.length !== 0) return 3; // clamped to an empty rest — no trap
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });

  it("still collects the tail for a normal rest", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let src: any[] = [1, 2, 3];
        let a: any, r: any;
        [a, ...r] = src;
        if (a !== 1) return 1;
        if (r.length !== 2 || r[0] !== 2 || r[1] !== 3) return 2;
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });
});
