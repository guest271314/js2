// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3040 — a variable captured from an enclosing scope and used ONLY inside a
 * parameter DEFAULT initializer was not threaded into the lifted function, so it
 * read as `null`. For an array-destructured parameter with such a default
 * (`function*([x] = iter)` where `iter` is a captured custom iterable) this threw
 * "Cannot destructure 'null' or 'undefined'". This blocked the last two of
 * #2664's merge_group regressions:
 *   language/expressions/async-generator/dstr/{dflt,named-dflt}-ary-init-iter-close.js
 *
 * Root cause: the capture-analysis sites built their referenced-name set from the
 * function BODY only, never scanning parameter-default initializers. Two sites are
 * fixed here:
 *   1. src/codegen/closures.ts   — the arrow / function-EXPRESSION closure
 *      lowering. This covers the async-generator / generator / function EXPRESSION
 *      variants of the `ary-init-iter-close` cluster — including the two #2664
 *      gate files. Verified below via the host lane.
 *   2. src/codegen/literals.ts   — object-literal plain methods, which capture via
 *      `promoteAccessorCapturesToGlobals` global promotion; it was called WITHOUT
 *      the param-default `extraNodes` the class-method / getter-setter paths
 *      already pass (#1161). Validated by the test262 `object/dstr/meth-dflt-*` and
 *      `gen-meth-dflt-*` cluster (host-lane object-method calls are not directly
 *      observable through `compileAndInstantiate`, so that path is covered in CI /
 *      merge_group rather than here).
 *
 * The plain function-DECLARATION path (statements/nested-declarations.ts) is a
 * SEPARATE follow-up (see the issue file "Deferred: declaration path"): threading
 * a param-default capture there shifts the function to the has-captures lowering,
 * whose call-site capture threading — unlike the closures path — does not
 * transitively thread a default-only capture through a CLOSURE caller
 * (`assert.throws(() => f())`, the standard test262 error-test shape), regressing
 * the destructuring `*-err` families. That path needs global promotion /
 * transitive threading and is out of scope here.
 */
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

/** A test262-shape custom iterable (assigned after the literal) that yields `7`
 * once then is exhausted, and records IteratorClose via `return()` (+100). */
const ITER_SRC = (calls = "calls") => `
  let ${calls} = 0;
  const iter: any = {};
  iter[Symbol.iterator] = function () {
    let done = false;
    return {
      next: function () {
        ${calls}++;
        if (done) return { value: undefined, done: true };
        done = true;
        return { value: 7, done: false };
      },
      return: function () { ${calls} += 100; return {}; },
    };
  };`;

describe("#3040 — captured custom-iterable used only in a param default (expression path)", () => {
  it("function EXPRESSION generator: captured iterable default is iterated (value 7)", async () => {
    const ex = (await compileAndInstantiate(`
      function outer(): number {
        ${ITER_SRC()}
        const g = function* ([x] = iter): any { yield x; };
        return g().next().value;
      }
      export function test(): number { return outer(); }
    `)) as { test: () => number };
    expect(ex.test()).toBe(7);
  });

  it("function EXPRESSION: captured iterable default, sync function value 7", async () => {
    const ex = (await compileAndInstantiate(`
      function outer(): number {
        ${ITER_SRC()}
        const f = function ([x] = iter): any { return x; };
        return f();
      }
      export function test(): number { return outer(); }
    `)) as { test: () => number };
    expect(ex.test()).toBe(7);
  });

  it("IteratorClose: an unexhausted captured iterable default calls return() once", async () => {
    // `[x]` consumes 1 of an iterator that is not done, so §8.5.2 IteratorClose
    // must invoke `return()` (recorded as +100). One next() (+1) + one return()
    // (+100) => 101. This is exactly what the #2664 gate files assert
    // (doneCallCount === 1).
    const ex = (await compileAndInstantiate(`
      function outer(): number {
        ${ITER_SRC()}
        const g = function* ([x] = iter): any { yield x; };
        g().next();
        return calls;
      }
      export function test(): number { return outer(); }
    `)) as { test: () => number };
    expect(ex.test()).toBe(101);
  });

  it("provided argument suppresses the default (iterable is not iterated)", async () => {
    const ex = (await compileAndInstantiate(`
      function outer(): number {
        ${ITER_SRC()}
        const g = function* ([x] = iter): any { yield x; };
        const v = g([9]).next().value;
        return v + calls; // 9 + 0 (iter never touched)
      }
      export function test(): number { return outer(); }
    `)) as { test: () => number };
    expect(ex.test()).toBe(9);
  });

  it("captured plain (non-iterable) value used only in an EXPRESSION param default", async () => {
    const ex = (await compileAndInstantiate(`
      function outer(): number {
        const base = 41;
        const f = function (x = base + 1): number { return x; };
        return f();
      }
      export function test(): number { return outer(); }
    `)) as { test: () => number };
    expect(ex.test()).toBe(42);
  });

  it("nested binding-pattern default also captures its enclosing reference", async () => {
    const ex = (await compileAndInstantiate(`
      function outer(): number {
        const fallback = 5;
        const emptyIter: any = {};
        emptyIter[Symbol.iterator] = function () {
          return { next: function () { return { value: undefined, done: true }; } };
        };
        const f = function ([x = fallback] = emptyIter): any { return x; };
        return f();
      }
      export function test(): number { return outer(); }
    `)) as { test: () => number };
    expect(ex.test()).toBe(5);
  });
});
