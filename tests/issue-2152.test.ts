// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2152 — Array HOF callbacks must bind the optional `thisArg` as the callback's
 * `this` (spec §23.1.3.* `Call(callbackfn, thisArg, «kValue,k,O»)`).
 *
 * Previously the compiler never forwarded `thisArg`; a callback's `this`
 * compiled to a literal `__get_undefined()`, so `arr.filter(fn, o)` saw
 * `this === undefined`. The fix installs `thisArg` into the `__current_this`
 * module global (save/restore) around the callback `call_ref`, and lets a
 * (nested or top-level) function declaration / function expression whose body
 * references its own `this` read that global (null-guarded → `undefined` for
 * direct calls, #1702). Pure Wasm global — works in standalone mode too.
 *
 * Arrow callbacks are lexically `this`-bound, so the `thisArg` is correctly
 * IGNORED for them.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

async function run(src: string): Promise<unknown> {
  const r = await compileToWasm(src);
  return (r as { test: () => unknown }).test();
}

describe("#2152 array HOF thisArg forwarding", () => {
  it("filter binds thisArg (object) as callback this (named decl)", async () => {
    expect(
      await run(`
        export function test(): number {
          var o: any = {}; o.res = true;
          function cb(v: any, i: any, a: any): any { return (this as any).res; }
          return [1].filter(cb, o).length;
        }`),
    ).toBe(1);
  });

  it("every binds thisArg as callback this", async () => {
    expect(
      await run(`
        export function test(): number {
          var o: any = {}; o.res = true;
          function cb(v: any, i: any, a: any): any { return (this as any).res; }
          return [1].every(cb, o) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("some binds thisArg as callback this", async () => {
    expect(
      await run(`
        export function test(): number {
          var o: any = {}; o.res = true;
          function cb(v: any, i: any, a: any): any { return (this as any).res; }
          return [1].some(cb, o) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("map reads thisArg.x via callback this (function expression)", async () => {
    expect(
      await run(`
        export function test(): number {
          var o: any = { x: 42 };
          return [1].map(function (v: any): any { return (this as any).x; }, o)[0];
        }`),
    ).toBe(42);
  });

  it("forEach binds thisArg as callback this", async () => {
    expect(
      await run(`
        export function test(): number {
          var o: any = { acc: 7 };
          var seen = 0;
          [1, 2].forEach(function (v: any): void { seen = seen + (this as any).acc; }, o);
          return seen;
        }`),
    ).toBe(14);
  });

  it("find binds thisArg as callback this", async () => {
    expect(
      await run(`
        export function test(): number {
          var o: any = { want: 2 };
          var r = [1, 2, 3].find(function (v: number): boolean { return v === (this as any).want; }, o);
          return r as number;
        }`),
    ).toBe(2);
  });

  it("findIndex binds thisArg as callback this", async () => {
    expect(
      await run(`
        export function test(): number {
          var o: any = { want: 3 };
          return [1, 2, 3].findIndex(function (v: number): boolean { return v === (this as any).want; }, o);
        }`),
    ).toBe(2);
  });

  it("callback this with NO thisArg is undefined (matches host)", async () => {
    expect(
      await run(`
        export function test(): number {
          function cb(v: any): any { return (this as any) === undefined ? 1 : 0; }
          return [1, 2, 3].filter(cb).length;
        }`),
    ).toBe(3);
  });

  it("arrow callback ignores thisArg (lexical this stays undefined)", async () => {
    // Arrow `this` is lexical — at module top level it is `undefined`, so the
    // passed thisArg must NOT change it (spec). The arrow keeps every element.
    expect(
      await run(`
        export function test(): number {
          var o: any = { x: 7 };
          return [1, 2, 3].filter((v: number): boolean => (this as any) === undefined, o).length;
        }`),
    ).toBe(3);
  });

  it("reduce takes NO thisArg (2nd arg is initialValue, not this)", async () => {
    // reduce(callbackfn, initialValue) — the 2nd arg must be the accumulator
    // seed, never bound as `this`. Confirms we did not mis-wire thisArg here.
    expect(
      await run(`
        export function test(): number {
          return [1, 2, 3].reduce((acc: number, v: number): number => acc + v, 10);
        }`),
    ).toBe(16);
  });

  it("nested HOF restores this (no stale receiver leak)", async () => {
    // Inner map installs its own thisArg; after it returns, the outer callback's
    // this must be restored to the outer thisArg.
    expect(
      await run(`
        export function test(): number {
          var outer: any = { tag: 100 };
          var inner: any = { tag: 1 };
          function outerCb(v: number): number {
            var innerSum = [1].map(function (w: number): number { return (this as any).tag; }, inner)[0];
            return (this as any).tag + innerSum;
          }
          return [1].map(outerCb, outer)[0];
        }`),
    ).toBe(101);
  });
});
