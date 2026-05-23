/**
 * #1565 — ToBoolean(BigInt) must use i64.eqz, not f64.convert_i64_s (§7.1.2).
 *
 * Per ECMA-262 §7.1.2 ToBoolean, the BigInt path is binary: `0n` is `false`,
 * every other BigInt is `true`. Routing through `f64.convert_i64_s` first
 * (the old behaviour) both produced a Wasm type error (i64 left on the stack
 * for `Boolean(...)`) and would lose precision for |x| > 2^53.
 *
 * Fix in `src/codegen/expressions/calls.ts`: add an i64 case to the
 * `Boolean(x)` handler — `i64.eqz` then `i32.eqz` (zero → false, nonzero →
 * true). The `if (bigint)` condition path already had an i64.eqz branch in
 * `ensureI32Condition`, so this completes the coverage.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #1565 — ToBoolean(BigInt) via i64.eqz", () => {
  it("Boolean(0n) === false", async () => {
    const ex = await compileToWasm("export function test(): boolean { return Boolean(0n); }");
    expect(ex.test!()).toBe(0);
  });

  it("Boolean(1n) === true", async () => {
    const ex = await compileToWasm("export function test(): boolean { return Boolean(1n); }");
    expect(ex.test!()).toBe(1);
  });

  it("Boolean of a BigInt > 2^53 === true (no f64 precision loss)", async () => {
    // 9007199254780000n > Number.MAX_SAFE_INTEGER. Going through
    // f64.convert_i64_s would be lossy but still truthy here; the point is
    // the i64.eqz path never rounds toward zero. (BigInts wider than i64 —
    // e.g. 2n ** 100n — are a separate representation limit, not in scope.)
    const ex = await compileToWasm("export function test(): boolean { return Boolean(9007199254780000n); }");
    expect(ex.test!()).toBe(1);
  });

  it("if (0n) does not enter the branch", async () => {
    const ex = await compileToWasm("export function test(): number { if (0n) { return 1; } return 0; }");
    expect(ex.test!()).toBe(0);
  });

  it("if (5n) enters the branch", async () => {
    const ex = await compileToWasm("export function test(): number { if (5n) { return 1; } return 0; }");
    expect(ex.test!()).toBe(1);
  });
});
