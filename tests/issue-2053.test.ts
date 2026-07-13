import { describe, it, expect } from "vitest";
import { compileAndRunImportObject as compileAndRun } from "./helpers/compile.js";

// #2053 — a spread followed by trailing positional args used to greedily
// consume every remaining parameter, reading past the spread array (OOB → NaN)
// and leaving the trailing args as surplus stack values. The fix reserves the
// trailing positional param slots so the spread only fills the params it covers.

const SUM3 = `function sum3(a: number, b: number, c: number): number { return a * 100 + b * 10 + c; }`;
const SUM4 = `function sum4(a: number, b: number, c: number, d: number): number { return a * 1000 + b * 100 + c * 10 + d; }`;

describe("#2053 spread followed by trailing positional args", () => {
  it("spread then one trailing positional", async () => {
    const e = await compileAndRun(
      SUM3 + `export function f(): number { const arr: number[] = [1, 2]; return sum3(...arr, 3); }`,
    );
    expect(e.f()).toBe(123);
  });

  it("leading positional then spread (unregressed)", async () => {
    const e = await compileAndRun(
      SUM3 + `export function f(): number { const arr: number[] = [2, 3]; return sum3(1, ...arr); }`,
    );
    expect(e.f()).toBe(123);
  });

  it("spread fills exact arity (unregressed)", async () => {
    const e = await compileAndRun(
      SUM3 + `export function f(): number { const arr: number[] = [1, 2, 3]; return sum3(...arr); }`,
    );
    expect(e.f()).toBe(123);
  });

  it("spread in the middle with trailing positional", async () => {
    const e = await compileAndRun(
      SUM3 + `export function f(): number { const arr: number[] = [2]; return sum3(1, ...arr, 3); }`,
    );
    expect(e.f()).toBe(123);
  });

  it("spread then two trailing positionals", async () => {
    const e = await compileAndRun(
      SUM4 + `export function f(): number { const arr: number[] = [1, 2]; return sum4(...arr, 3, 4); }`,
    );
    expect(e.f()).toBe(1234);
  });

  it("middle spread covering one element", async () => {
    const e = await compileAndRun(
      SUM4 + `export function f(): number { const arr: number[] = [2, 3]; return sum4(1, ...arr, 4); }`,
    );
    expect(e.f()).toBe(1234);
  });

  it("short spread plus two trailing positionals", async () => {
    const e = await compileAndRun(
      SUM3 + `export function f(): number { const arr: number[] = [1]; return sum3(...arr, 2, 3); }`,
    );
    expect(e.f()).toBe(123);
  });
});
