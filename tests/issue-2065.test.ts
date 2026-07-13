import { describe, it, expect } from "vitest";
import { compileAndRunImportObject as compileAndRun } from "./helpers/compile.js";

// #2065 — the for-of array fast path hoisted the vec's `length` and `data` into
// locals once before the loop, so elements pushed during iteration were never
// visited and popped elements were still visited (and a reallocated backing
// array left `data` stale). When the iterable is a plain identifier whose array
// the body may mutate, the loop now re-reads length/data from the vec each
// iteration. Non-mutating loops keep the hoisted fast path.

describe("#2065 for-of observes mid-iteration array mutation", () => {
  it("push during iteration is visited", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         const arr: number[] = [1, 2, 3];
         let log = 0;
         for (const x of arr) { log = log * 10 + x; if (x === 1) arr.push(4); }
         return log;
       }`,
    );
    expect(e.f()).toBe(1234);
  });

  it("pop during iteration stops early", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         const arr: number[] = [1, 2, 3, 4];
         let log = 0;
         for (const x of arr) { log = log * 10 + x; arr.pop(); }
         return log;
       }`,
    );
    expect(e.f()).toBe(12);
  });

  it("growth past capacity (reallocation) is observed", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         const arr: number[] = [1, 2, 3];
         let count = 0;
         for (const x of arr) { count++; if (count <= 3) arr.push(x + 10); }
         return count;
       }`,
    );
    expect(e.f()).toBe(6);
  });

  it("arr.length = n shrink is observed", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         const arr: number[] = [1, 2, 3, 4];
         let log = 0;
         for (const x of arr) { log = log * 10 + x; arr.length = 2; }
         return log;
       }`,
    );
    expect(e.f()).toBe(12);
  });

  it("reassigning the binding does not change the iterated array", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         let arr: number[] = [1, 2, 3];
         let log = 0;
         for (const x of arr) { log = log * 10 + x; arr = [9, 9, 9, 9]; }
         return log;
       }`,
    );
    expect(e.f()).toBe(123);
  });

  it("non-mutating loop keeps the hoisted fast path (unregressed)", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         const arr: number[] = [5, 6, 7];
         let s = 0;
         for (const x of arr) { s += x; }
         return s;
       }`,
    );
    expect(e.f()).toBe(18);
  });
});
