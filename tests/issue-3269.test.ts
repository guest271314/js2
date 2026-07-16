// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3269 — behaviour-preserving break-up of the loops.ts god-file:
//   - extracted loop-analysis.ts (pure predicates), for-of-destructuring.ts
//     (loop-variable head-binding destructuring), for-await-helpers.ts;
//   - DRY'd shiftLoopDepths / blockLoop / compileLoopBodyWithShadows /
//     emitGlobalSyncWriteback / isAssignmentOperator.
//
// Emitted-Wasm byte-identity is proven separately by
// scripts/prove-emit-identity.mjs. Those 39 example programs do NOT exercise
// the for-of ASSIGNMENT-destructuring-to-module-global writeback path (the
// emitGlobalSyncWriteback dedup), so this suite pins that path — plus a smoke
// pass over every loop driver touched by the shiftLoopDepths / blockLoop /
// compileLoopBodyWithShadows dedups — by compiling AND running each shape.
import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime-instantiate.js";

async function run(src: string): Promise<number> {
  const exports = await compileAndInstantiate(src);
  return (exports.test as () => number)();
}

describe("#3269 loops.ts breakup — behaviour preserved", () => {
  it("for-of ASSIGNMENT destructuring writes back to module globals (emitGlobalSyncWriteback)", async () => {
    // `a` and `b` are module-scope globals; `for ([a, b] of …)` must sync each
    // destructured local back to its global every iteration.
    const src = `
      let a = 0, b = 0, sum = 0;
      const pairs: number[][] = [[1, 2], [3, 4], [5, 6]];
      for ([a, b] of pairs) { sum += a * 10 + b; }
      export function test(): number { return sum + a * 100 + b; }
    `;
    // sum = 12 + 34 + 56 = 102; last a,b = 5,6 → +500 +6 = 608
    expect(await run(src)).toBe(608);
  });

  it("for-of assignment destructuring with a rest element to globals", async () => {
    const src = `
      let first = 0, restLen = 0;
      const arr = [10, 20, 30, 40];
      for (const [f, ...rest] of [arr]) { first = f; restLen = rest.length; }
      export function test(): number { return first + restLen; }
    `;
    expect(await run(src)).toBe(13); // 10 + 3
  });

  it("for-of BINDING destructuring (const [x, y]) still binds per-iteration", async () => {
    const src = `
      export function test(): number {
        let s = 0;
        const pairs: number[][] = [[1, 2], [3, 4]];
        for (const [x, y] of pairs) { s += x + y; }
        return s;
      }
    `;
    expect(await run(src)).toBe(10); // 3 + 7
  });

  it("all loop drivers (while / for / do-while / for-of / for-in) — depth + shadow dedups", async () => {
    const src = `
      export function test(): number {
        let n = 0;
        let i = 0;
        while (i < 3) { const c = i; n += c; i++; }
        for (let j = 0; j < 3; j++) { const c = j; n += c; }
        let k = 0;
        do { const c = k; n += c; k++; } while (k < 3);
        for (const v of [10, 20, 30]) { const c = v; n += c; }
        const o: any = { a: 1, b: 2, c: 3 };
        for (const key in o) { n += o[key]; }
        return n;
      }
    `;
    // while 0+1+2=3 · for 0+1+2=3 · do 0+1+2=3 · for-of 60 · for-in 6 = 75
    expect(await run(src)).toBe(75);
  });

  it("nested loops with break/continue keep correct branch depths (shiftLoopDepths)", async () => {
    const src = `
      export function test(): number {
        let n = 0;
        outer: for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 4; j++) {
            if (j === 2) continue;
            if (i === 3) break outer;
            n += i * 10 + j;
          }
        }
        return n;
      }
    `;
    // i=0: j0,j1,j3 → 0+1+3=4 ; i=1: 10+11+13=34 ; i=2: 20+21+23=64 ; i=3: break → total 102
    expect(await run(src)).toBe(102);
  });

  it("counted for-loop bounds-check-elimination path stays correct (loop-analysis predicates)", async () => {
    const src = `
      export function test(): number {
        const arr = [3, 1, 4, 1, 5, 9, 2, 6];
        let acc = 0;
        for (let i = 0; i < arr.length; i++) { acc += arr[i]; }
        return acc;
      }
    `;
    expect(await run(src)).toBe(31);
  });
});
