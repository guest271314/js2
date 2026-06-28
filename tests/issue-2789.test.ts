// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #2789 — packed-i32 array read-side soundness (hybrid fast-path audit
// Row 3). `collectI32SpecializedArrays` / `isI32SafeExprForArray`
// (src/codegen/array-element-typing.ts) lower a `number[]` to an `array<mut i32>`
// when every write looked "i32-safe". But the write check ACCEPTED `+`/`-`/`*`
// arithmetic ("overflow wraps mod 2^32") and `-0` — exactly the values whose
// i32 image differs from their f64 value. Those are stored via
// `i32.trunc_sat_f64_s` (which SATURATES on overflow) or collapse `-0`→`+0`, so a
// read promoting the element back to f64 observes a WRONG number. That is a
// MISCOMPILE, not a deopt.
//
// Fix (conservative narrowing, mirrors the #1236 scalar-local fix): demote any
// array with a `+`/`-`/`*` write, an arithmetic compound (`+=`/`-=`/`*=`), or a
// `-0`-producing unary minus to the always-correct f64 backing. Only CANONICAL
// i32 producers (bitwise/shift/comparison/`~`, i32 locals, non-zero integer
// literals, and wrap-canonicalising `(expr) | 0`) keep the i32 fast path. When
// every stored value is canonical, NO read can observe a distinction i32 erases
// — which discharges the read-side proof obligation for free.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndInstantiate(source: string): Promise<Record<string, Function>> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

async function watOf(source: string): Promise<string> {
  const r = await compile(source, { fileName: "test.ts" });
  expect(r.success).toBe(true);
  return r.wat ?? "";
}

/** A `number[]` local lowered to i32 registers the `$__vec_i32` vec type; a
 *  deopted (f64-backed) array's module contains only `$__vec_f64`. Each probe
 *  function below contains exactly one array, so the presence of `$__vec_i32`
 *  is a reliable proxy for "this array was packed to i32". */
function isI32Backed(wat: string): boolean {
  return /\$__vec_i32\b/.test(wat);
}

describe("#2789 — packed-i32 array read-side soundness", () => {
  describe("previously MISCOMPILED: overflow now uses the f64 backing", () => {
    it("`arr.push(a * b)` with a*b = 2.5e9 returns 2500000000, not i32 saturation", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let a = 50000 | 0;
          let b = 50000 | 0;
          let arr: number[] = [];
          arr.push(a * b);
          return arr[0];
        }
      `);
      const got = (exports.test as () => number)();
      expect(got).toBe(2500000000);
      // The bug returned i32.MAX (2147483647) via i32.trunc_sat_f64_s.
      expect(got).not.toBe(2147483647);
    });

    it("`arr.push(a + b)` with a+b = 4e9 returns 4000000000", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let a = 2000000000 | 0;
          let b = 2000000000 | 0;
          let arr: number[] = [];
          arr.push(a + b);
          return arr[0];
        }
      `);
      expect((exports.test as () => number)()).toBe(4000000000);
    });

    it("`arr[i] = a - b` underflow returns -4000000000", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let a = -2000000000 | 0;
          let b = 2000000000 | 0;
          let arr: number[] = new Array(1);
          arr[0] = a - b;
          return arr[0];
        }
      `);
      expect((exports.test as () => number)()).toBe(-4000000000);
    });

    it("compound `arr[i] += big` does not saturate", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let arr: number[] = [];
          arr.push(2000000000 | 0);
          arr[0] += (2000000000 | 0);
          return arr[0];
        }
      `);
      expect((exports.test as () => number)()).toBe(4000000000);
    });

    it("differential: V8 and Wasm agree on an overflowing product array", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let a = 46341 | 0;
          let b = 46341 | 0;
          let arr: number[] = [];
          arr.push(a * b);
          return arr[0];
        }
      `);
      const v8 = (46341 | 0) * (46341 | 0); // 2147488281 > 2^31
      expect((exports.test as () => number)()).toBe(v8);
    });
  });

  describe("previously MISCOMPILED: negative zero now preserved by f64 backing", () => {
    it("`arr.push(-0)` preserves the sign of zero (1/x === -Infinity)", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let arr: number[] = [];
          arr.push(-0);
          return 1 / arr[0];
        }
      `);
      // i32 collapses -0 -> +0, which made 1/x return +Infinity (the bug).
      expect((exports.test as () => number)()).toBe(-Infinity);
    });

    it("`arr[i] = -0` element-assign preserves -0", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let arr: number[] = new Array(1);
          arr[0] = -0;
          return 1 / arr[0];
        }
      `);
      expect((exports.test as () => number)()).toBe(-Infinity);
    });
  });

  describe("read-side observation of an i32-erased distinction", () => {
    it("overflowing value read into a float op divides correctly (not the wrapped int)", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let a = 50000 | 0;
          let b = 50000 | 0;
          let arr: number[] = [];
          arr.push(a * b);     // 2.5e9 — > 2^31
          return arr[0] / 2;   // float op observes the full magnitude
        }
      `);
      expect((exports.test as () => number)()).toBe(1250000000);
    });

    it("fractional value (division write) stays f64 — already correct, guarded", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let a = 7 | 0;
          let b = 2 | 0;
          let arr: number[] = [];
          arr.push(a / b);
          return arr[0];
        }
      `);
      expect((exports.test as () => number)()).toBe(3.5);
    });

    it("NaN write stays f64 — already correct, guarded", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let arr: number[] = [];
          arr.push(0 / 0);
          return arr[0] !== arr[0] ? 1 : 0; // NaN is the only value !== itself
        }
      `);
      expect((exports.test as () => number)()).toBe(1);
    });
  });

  describe("safe fast-path preserved: canonical-i32 writes still pack & stay correct", () => {
    it("`(a * b) | 0` keeps the i32 backing and yields the canonical ToInt32 value", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let a = 50000 | 0;
          let b = 50000 | 0;
          let arr: number[] = [];
          arr.push((a * b) | 0);
          return arr[0];
        }
      `);
      // ToInt32(2.5e9) — identical under both backings, so packing is sound.
      expect((exports.test as () => number)()).toBe(2500000000 | 0);
    });

    it("non-zero negative literals still pack and read back correctly", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let arr: number[] = [];
          arr.push(-1);
          arr.push(-5);
          return arr[0] + arr[1];
        }
      `);
      expect((exports.test as () => number)()).toBe(-6);
    });

    it("bitwise writes and bitwise compounds still pack and stay correct", async () => {
      const exports = await compileAndInstantiate(`
        export function test(): number {
          let a = 7 | 0;
          let arr: number[] = [];
          arr.push(a & 3);
          arr[0] |= 8;
          arr[0] >>= 1;
          return arr[0];
        }
      `);
      expect((exports.test as () => number)()).toBe(5);
    });
  });

  describe("WAT-level proof: dangerous arrays demote, canonical arrays keep i32", () => {
    it("`arr.push(a * b)` array is f64-backed (no $__vec_i32)", async () => {
      const wat = await watOf(`
        export function test(): number {
          let a = 50000 | 0;
          let b = 50000 | 0;
          let arr: number[] = [];
          arr.push(a * b);
          return arr[0];
        }
      `);
      expect(isI32Backed(wat)).toBe(false);
    });

    it("`arr.push(-0)` array is f64-backed (no $__vec_i32)", async () => {
      const wat = await watOf(`
        export function test(): number {
          let arr: number[] = [];
          arr.push(-0);
          return 1 / arr[0];
        }
      `);
      expect(isI32Backed(wat)).toBe(false);
    });

    it("arithmetic compound `arr[i] += E` array is f64-backed (no $__vec_i32)", async () => {
      const wat = await watOf(`
        export function test(): number {
          let arr: number[] = [];
          arr.push(1 | 0);
          arr[0] += (2 | 0);
          return arr[0];
        }
      `);
      expect(isI32Backed(wat)).toBe(false);
    });

    it("`(a * b) | 0` array is STILL i32-backed ($__vec_i32 present)", async () => {
      const wat = await watOf(`
        export function test(): number {
          let a = 50000 | 0;
          let b = 50000 | 0;
          let arr: number[] = [];
          arr.push((a * b) | 0);
          return arr[0];
        }
      `);
      expect(isI32Backed(wat)).toBe(true);
    });

    it("bitwise-only array is STILL i32-backed ($__vec_i32 present)", async () => {
      const wat = await watOf(`
        export function test(): number {
          let a = 7 | 0;
          let arr: number[] = [];
          arr.push(a & 3);
          arr[0] |= 8;
          return arr[0];
        }
      `);
      expect(isI32Backed(wat)).toBe(true);
    });
  });
});
