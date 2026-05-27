import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * Regression for the ~245-test test262 drop introduced by #1602 (PR #595).
 *
 * #1602 tightened the object-literal method dedup in
 * `compileObjectLiteralForStruct` (literals.ts): in addition to a param-COUNT
 * mismatch, a per-position param-TYPE mismatch now forks a fresh per-literal
 * funcIdx. The comparison used the strict `valTypesMatch`, which treats a
 * non-null `ref T` as different from `ref null T`. The pre-pass builds the
 * method's self param as a non-null `ref structTypeIdx`, but the actually
 * compiled method uses `ref null structTypeIdx` (and `ref null U` for any
 * default-initialised ref param). That spurious nullability "mismatch" forked
 * a fresh func for the SINGLE-literal common case — orphaning the original
 * shared funcMap entry with an empty body. A *direct* call like `o.method()`
 * dispatches via funcMap (not the per-literal map the closure path uses), so
 * it landed on the empty func and trapped ("dereferencing a null pointer").
 *
 * This regressed 187 `language/expressions/object/dstr/*` and 22
 * `.../method-definition/*` tests (object methods with destructured / default
 * params, directly invoked). The fix compares ref/ref_null of the same struct
 * typeIdx as equal, so the spurious fork no longer happens, while genuine
 * type/order divergence (different `kind`/`typeIdx`, e.g. [f64, externref] vs
 * [externref, f64]) is still detected (covered by tests/issue-1602.test.ts).
 */
describe("#1602 regression — object method default/destructured params, direct call", () => {
  it("array-destructured default param", async () => {
    const e = await compileToWasm(`
      let c = 0;
      const o = {
        method([x, y, z] = [1, 2, 3]): void {
          if (x !== 1 || y !== 2 || z !== 3) throw new Error("bad");
          c = c + 1;
        }
      };
      export function test(): number { o.method(); return c; }
    `);
    expect(e.test()).toBe(1);
  });

  it("object-destructured default param", async () => {
    const e = await compileToWasm(`
      let c = 0;
      const o = {
        method({ a, b } = { a: 7, b: 8 }): void {
          if (a !== 7 || b !== 8) throw new Error("bad");
          c = c + 1;
        }
      };
      export function test(): number { o.method(); return c; }
    `);
    expect(e.test()).toBe(1);
  });

  it("explicit arg still overrides the default", async () => {
    const e = await compileToWasm(`
      let c = 0;
      const o = { method([x] = [9]): void { c = c + x; } };
      export function test(): number { o.method([42]); o.method(); return c; }
    `);
    expect(e.test()).toBe(51);
  });
});
