// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1720 — reference evaluation order for `++`/`--` on a member
 * reference whose base is `null` / `undefined`: `base[prop()]++`.
 *
 * Per ECMA-262 §13.4 (UpdateExpression), the LeftHandSideExpression is first
 * evaluated to a Reference, and only then does `GetValue` force the ToNumeric
 * coercion. Evaluating the member reference `base[key]` (§13.3.3) evaluates
 * BOTH the base sub-expression and the property-key sub-expression — with all
 * their side effects — before the Reference is resolved. `GetValue` of a
 * Reference whose base is `null`/`undefined` throws a **TypeError**
 * (RequireObjectCoercible) BEFORE `ToPropertyKey` would coerce the key (so the
 * key's `toString` is never called).
 *
 * Before this fix, the externref element-access path in
 * `compileMemberIncDec` dropped the base and emitted `f64.const NaN`
 * without ever compiling the property-key expression. So:
 *   - `base[prop()]++` silently skipped `prop()` (its side effect was lost),
 *   - a `null` base produced `NaN` instead of throwing TypeError.
 *
 * Test262 cases driving the fix (the `*_A6_T1.js` "evaluated exactly once"
 * tests for all four update operators):
 *   language/expressions/postfix-increment/S11.3.1_A6_T1.js
 *   language/expressions/postfix-decrement/S11.3.2_A6_T1.js
 *   language/expressions/prefix-increment/S11.4.4_A6_T1.js
 *   language/expressions/prefix-decrement/S11.4.5_A6_T1.js
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1720 — inc/dec reference evaluation order on null base", () => {
  // The property-key expression's side effect must run even though the base is
  // null and the update ultimately throws.
  for (const op of ["++", "--"] as const) {
    for (const fix of ["postfix", "prefix"] as const) {
      const expr = fix === "postfix" ? `base[prop()]${op}` : `${op}base[prop()]`;
      it(`${fix} ${op}: property-key expression runs once before the throw (${expr})`, async () => {
        expect(
          await runWasm(`export function test(): number {
            var calls: number = 0;
            var base: any = null;
            var prop: any = function () { calls = calls + 1; return "k"; };
            try { ${expr}; } catch (e) {}
            return calls;
          }`),
        ).toBe(1);
      });

      it(`${fix} ${op}: null base throws (${expr})`, async () => {
        expect(
          await runWasm(`export function test(): number {
            var base: any = null;
            var threw: number = 0;
            try { ${expr}; } catch (e) { threw = 1; }
            return threw;
          }`),
        ).toBe(1);
      });
    }
  }

  it("null base throws a TypeError instance, not NaN", async () => {
    expect(
      await runWasm(`export function test(): number {
        var base: any = null;
        var isTE: number = 0;
        try { base["k"]++; } catch (e) { isTE = (e instanceof TypeError) ? 1 : 0; }
        return isTE;
      }`),
    ).toBe(1);
  });

  it("null base: property key's toString is NOT called (TypeError thrown first)", async () => {
    // RequireObjectCoercible inside GetValue throws before ToPropertyKey, so a
    // non-side-effecting object key's `toString` must never run.
    expect(
      await runWasm(`export function test(): number {
        var base: any = null;
        var tsCalled: number = 0;
        var key: any = { toString: function () { tsCalled = 1; return "k"; } };
        try { base[key]++; } catch (e) {}
        return tsCalled;
      }`),
    ).toBe(0);
  });

  it("non-null externref base property inc/dec still yields NaN (unchanged)", async () => {
    expect(
      await runWasm(`export function test(): number {
        var o: any = {};
        var r: any = o["missing"]++;
        return Number.isNaN(r) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
