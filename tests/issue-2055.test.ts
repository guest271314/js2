import { describe, it, expect } from "vitest";
import { compileAndRunImportObject as compileAndRun } from "./helpers/compile.js";

// #2055 — a relational comparison where one operand is an i32-promoted loop var
// used to force the i32 numeric hint onto the *other* operand, truncating a
// fractional f64 (e.g. `i < 2.5` became `i < 2`) via i32.trunc_sat_f64_s. The
// fix only takes the i32 fast path when BOTH operands are provably i32-pure;
// otherwise the i32 local is promoted to f64 and an f64 compare is emitted.

describe("#2055 relational i32 hint must not truncate a fractional f64 operand", () => {
  it("if (i < 2.5) with i32 loop var", async () => {
    const e = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 5; i++) { if (i < 2.5) c++; } return c; }`,
    );
    expect(e.f()).toBe(3);
  });

  it("if (i < n / 2) — derived f64 operand", async () => {
    const e = await compileAndRun(
      `export function f(n: number): number { let c = 0; for (let i = 0; i < 5; i++) { if (i < n / 2) c++; } return c; }`,
    );
    expect(e.f(5)).toBe(3);
  });

  it("fractional literal on the left (2.5 > i)", async () => {
    const e = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 5; i++) { if (2.5 > i) c++; } return c; }`,
    );
    expect(e.f()).toBe(3);
  });

  it("all four relational ops with a fractional bound", async () => {
    const lt = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 5; i++) { if (i <= 2.5) c++; } return c; }`,
    );
    expect(lt.f()).toBe(3);
    const gt = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 5; i++) { if (i > 2.5) c++; } return c; }`,
    );
    expect(gt.f()).toBe(2);
    const ge = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 5; i++) { if (i >= 2.5) c++; } return c; }`,
    );
    expect(ge.f()).toBe(2);
  });

  it("while-body and ternary contexts", async () => {
    const w = await compileAndRun(
      `export function f(x: number): number { let c = 0; let i = 0; while (i < x / 2) { c++; i++; } return c; }`,
    );
    expect(w.f(5)).toBe(3);
    const t = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 5; i++) { c += (i < 2.5) ? 1 : 0; } return c; }`,
    );
    expect(t.f()).toBe(3);
  });

  it("integer comparisons still take the i32 fast path (unregressed)", async () => {
    const e = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 5; i++) { if (i < 3) c++; } return c; }`,
    );
    expect(e.f()).toBe(3);
  });

  it("two i32 loop vars compared directly (unregressed)", async () => {
    const e = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 5; i++) { let j = 3; if (i < j) c++; } return c; }`,
    );
    expect(e.f()).toBe(3);
  });

  it("large-bound for-header loop runs the full count (perf path intact)", async () => {
    const e = await compileAndRun(
      `export function f(): number { let c = 0; for (let i = 0; i < 10000; i++) { c++; } return c; }`,
    );
    expect(e.f()).toBe(10000);
  });
});
