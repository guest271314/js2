/**
 * #2845 — Assignment-EXPRESSION destructuring default initializers
 * (`[a = d] = src` and `{ k: x = d } = src`) did not fire correctly when the
 * source element/property was ABSENT (out-of-bounds for arrays, or an
 * `undefined`/missing property for objects). Carved from the #2669 umbrella.
 *
 * Three sibling defects in `compileArrayDestructuringAssignment` /
 * `compileDestructuringAssignment` (all "default fires iff the value is
 * `undefined`" mis-implementations of §13.15.5.5 AssignmentElement /
 * §13.15.5.3 ObjectAssignmentPattern):
 *
 *   A. Array, numeric (f64/i32) element: the default branch DROPPED the default
 *      entirely (only ref/externref elements were handled), and an out-of-bounds
 *      vec read produced a garbage sentinel (NaN/0) rather than firing the
 *      default. `[a = 1, b = 2] = []` left a/b at NaN; `[a = (x+=1)] = []`
 *      returned NaN and never ran the side effect.
 *   B. Object `{ k: x = d }` (property-renamed target, typed struct): used
 *      `ref.is_null` instead of `__extern_is_undefined`, so an `undefined`-valued
 *      property did not fire the default (`{ y: x = 1 } = { y: undefined }` left
 *      x at undefined→0); and a MISSING field (`{ y: x = 1 } = {}`) was skipped
 *      entirely so the default never ran.
 *   C. Object no-struct (externref) path only handled shorthand props, so
 *      `{ y: x = 1 } = {}` (property form) dropped the binding.
 *
 * Fix (assignment.ts): the array default now bounds-checks (`i < length`) and
 * only reads in-bounds (so a non-null `ref` element never traps on OOB
 * `ref.as_non_null`), mapping array holes → undefined; OOB / undefined / hole all
 * fire the default uniformly for numeric AND externref elements. The object
 * property path now fires the default on a missing field and uses
 * `__extern_is_undefined` for externref fields; the no-struct path handles
 * `{ k: x = d }` property form too.
 *
 * Recovered +9 in language/expressions/assignment/dstr/ (incl. 2 yield-in-default
 * bonus tests), 0 regressions. The residual heterogeneous-null cases
 * (`[v = 11] = [null]` typed numeric → null reads as 0) are a separate
 * value-representation issue (#2769 family), not default-firing.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { wrapTest } from "./test262-runner.js";

async function runWrappedJs(jsSource: string): Promise<unknown> {
  const wrapped = wrapTest(jsSource, {} as any);
  const r = await compile(wrapped.source, { fileName: "test.ts", allowJs: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(r.imports, undefined, r.stringPool, { globalSandbox: {} });
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  importResult.setExports?.(instance.exports as any);
  return (instance.exports as any).test();
}

describe("#2845 — assignment-expression destructuring default initializers", () => {
  // ---- Defect A: array numeric-element default + out-of-bounds ----

  it("array-elem-init-evaluation — default fires only for the absent (OOB) element", async () => {
    // vals=[14]: element 0 present (default skipped → flag1 stays false),
    // element 1 out of bounds (default fires → flag2 = true).
    const js = `
      var flag1 = false, flag2 = false;
      var _;
      var result;
      var vals = [14];
      result = [ _ = flag1 = true, _ = flag2 = true ] = vals;
      assert.sameValue(flag1, false);
      assert.sameValue(flag2, true);
      assert.sameValue(result, vals);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("array-elem-init-order — OOB defaults evaluate left-to-right with side effects", async () => {
    const js = `
      var x = 0;
      var a, b;
      var result;
      var vals = [];
      result = [ a = x += 1, b = x *= 2 ] = vals;
      assert.sameValue(a, 1);
      assert.sameValue(b, 2);
      assert.sameValue(x, 2);
      assert.sameValue(result, vals);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("array numeric default fires when source shorter than pattern", async () => {
    const js = `
      var a, b, c;
      var vals = [7];
      [ a = 1, b = 2, c = 3 ] = vals;
      assert.sameValue(a, 7);
      assert.sameValue(b, 2);
      assert.sameValue(c, 3);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("array numeric default skipped when element present (regression control)", async () => {
    const js = `
      var a, b;
      var vals = [5, 6];
      [ a = 9, b = 9 ] = vals;
      assert.sameValue(a, 5);
      assert.sameValue(b, 6);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  // ---- Defect B: object { k: x = d } typed-struct property target ----

  it("obj-prop-elem-init-assignment-undef — default fires for undefined property", async () => {
    const js = `
      var x;
      var result;
      var vals = { y: undefined };
      result = { y: x = 1 } = vals;
      assert.sameValue(x, 1);
      assert.sameValue(result, vals);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("obj-prop-elem-init-assignment-null — default does NOT fire for null (regression control)", async () => {
    const js = `
      var x;
      var result;
      var vals = { y: null };
      result = { y: x = 1 } = vals;
      assert.sameValue(x, null);
      assert.sameValue(result, vals);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("obj-prop-elem-init present property skips default (regression control)", async () => {
    const js = `
      var x;
      var vals = { y: 9 };
      ({ y: x = 1 } = vals);
      assert.sameValue(x, 9);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("obj-prop-elem-init-evaluation — present skips, absent fires (left-to-right)", async () => {
    const js = `
      var flag1 = false;
      var flag2 = false;
      var x, y;
      var result;
      var vals = { y: 1 };
      result = { x: x = flag1 = true, y: y = flag2 = true } = vals;
      assert.sameValue(x, true, 'value of x');
      assert.sameValue(flag1, true, 'value of flag1');
      assert.sameValue(y, 1, 'value of y');
      assert.sameValue(flag2, false, 'value of flag2');
      assert.sameValue(result, vals);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  // ---- Defect C: object { k: x = d } with an absent/no-struct source ----

  it("obj-prop-elem-init-assignment-missing — default fires for absent field", async () => {
    const js = `
      var x;
      var result;
      var vals = {};
      result = { y: x = 1 } = vals;
      assert.sameValue(x, 1);
      assert.sameValue(result, vals);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("obj-prop-elem-init-in — default expression (the `in` operator) evaluates for absent field", async () => {
    const js = `
      var prop;
      var result;
      var vals = {};
      result = { x: prop = 'x' in {} } = vals;
      assert.sameValue(prop, false);
      assert.sameValue(result, vals);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  // ---- Regression controls: shorthand + no-default still correct ----

  it("shorthand object default still fires on missing field", async () => {
    const js = `
      var x;
      var vals = {};
      ({ x = 1 } = vals);
      assert.sameValue(x, 1);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("property-renamed target without default still extracts the value", async () => {
    const js = `
      var x;
      var vals = { y: 7 };
      ({ y: x } = vals);
      assert.sameValue(x, 7);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("plain array assignment destructuring (no default) unchanged", async () => {
    const js = `
      var a, b, c;
      var vals = [3, 4, 5];
      [a, b, c] = vals;
      assert.sameValue(a, 3);
      assert.sameValue(b, 4);
      assert.sameValue(c, 5);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });
});
