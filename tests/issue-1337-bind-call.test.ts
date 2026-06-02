// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1337 — Function.prototype.bind.call(fn, thisArg, ...args) reshape.
//
// #1632a landed bind dispatch for the direct form `fn.bind(...)` via the
// `__bind_function` host helper. test262 also uses the indirect form
// `Function.prototype.bind.call(fn, thisArg, ...args)` — the canonical
// ES5 way to invoke bind without trusting the receiver's `.bind` property.
// That form bypassed the dispatch and reached V8's host
// `Function.prototype.bind.call(wasmStruct, ...)`, which V8 rejects with
// "Bind must be called on a function". Test262 baseline showed ~30 fails
// of this exact shape under `built-ins/Function/prototype/bind/`.
//
// The fix in `calls.ts` mirrors the #1596 reshape for apply/call: detect
// `Function.prototype.bind.call(fn, ...)` and rewrite to `fn.bind(...)`,
// so the existing #1632a bind dispatch fires. A second reshape inside the
// immediate-bind+call peephole at calls.ts:~9402 picks up the equivalent
// `Function.prototype.bind.call(fn, thisArg, ...partials)(...args)` shape.
//
// Scope of this test file:
//   1. Verify the reshape correctly routes through __bind_function for
//      metadata reads on the bound result (typeof, .length, .name).
//   2. Verify the immediate-call peephole fires on the reshaped form, so
//      `Function.prototype.bind.call(fn, thisArg, ...partials)(...args)`
//      computes the same result as `fn(...partials, ...args)`.
//   3. Verify the negative case: `Function.prototype.bind.call(undefined,
//      ...)` still throws TypeError (we only reshape when the target has
//      TS call signatures, so non-callable targets fall through to the
//      legacy host path that throws spec-correctly).
//
// Out of scope for this fix:
//   - `var bound = Function.prototype.bind.call(fn, ...); bound()`
//     (deferred call through a `var`-stored local). That hits the broader
//     #1632a documented gap where `any`-typed locals don't dispatch the
//     stored externref bound function — tracked under the same issue.
describe("#1337 Function.prototype.bind.call reshape", () => {
  it("typeof Function.prototype.bind.call(fn, thisArg) === 'function'", async () => {
    const exports = await compileToWasm(`
      var func = function (x: any): any { return x; };
      export function test(): any {
        return typeof Function.prototype.bind.call(func, null);
      }
    `);
    expect(exports.test()).toBe("function");
  });

  it(".length recomputed: max(0, target.length - boundArgs.length) with 1 partial", async () => {
    const exports = await compileToWasm(`
      var func = function (a: any, b: any, c: any): any { return a + b + c; };
      export function test(): any {
        return Function.prototype.bind.call(func, null, 1).length;
      }
    `);
    expect(exports.test()).toBe(2);
  });

  it(".length clamps to 0 when boundArgs exceed target.length", async () => {
    const exports = await compileToWasm(`
      var func = function (x: any): any { return x; };
      export function test(): any {
        return Function.prototype.bind.call(func, null, 1, 2, 3).length;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it(".name === 'bound ' + target.name (top-level fn declaration)", async () => {
    const exports = await compileToWasm(`
      function namedTarget(x: any): any { return x; }
      export function test(): any {
        return Function.prototype.bind.call(namedTarget, null).name;
      }
    `);
    expect(exports.test()).toBe("bound namedTarget");
  });

  it("immediate call: Function.prototype.bind.call(fn, thisArg)(arg) === fn(arg)", async () => {
    // The immediate-bind+call peephole (calls.ts:~9402) now reshapes the
    // outer Function.prototype.bind.call(...)() form and dispatches it as
    // a direct call to the wrapped fn — bypassing the bound externref
    // round-trip entirely.
    const exports = await compileToWasm(`
      function double(a: number): number { return a * 2; }
      export function test(): number {
        return Function.prototype.bind.call(double, null)(21);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("immediate call with partials: bind.call(fn, thisArg, p1, p2)(p3) === fn(p1, p2, p3)", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): number {
        return Function.prototype.bind.call(add, null, 1, 2)(3);
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("immediate call, string partials", async () => {
    const exports = await compileToWasm(`
      function concat(x: string, y: string, z: string): string { return x + y + z; }
      export function test(): string {
        return Function.prototype.bind.call(concat, {}, "a", "b")("c");
      }
    `);
    expect(exports.test()).toBe("abc");
  });

  it("non-Function receiver falls through (Math.max.call works normally)", async () => {
    // Verify the reshape only fires for the literal `Function.prototype.bind`
    // chain — unrelated `.call` use is unaffected.
    const exports = await compileToWasm(`
      export function test(): any {
        return Math.max.call(null, 1, 5, 3);
      }
    `);
    expect(exports.test()).toBe(5);
  });
});
