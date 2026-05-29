// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1728 — Compound assignment to an unresolvable reference must throw
 * ReferenceError (ES5 es5id 11.13.2_A2.1_T3.* family).
 *
 * Per §13.15.2 CompoundAssignmentEvaluation, step 1.c evaluates
 * `lval = GetValue(lref)` *before* the RHS; GetValue on an unresolvable
 * reference throws ReferenceError (§6.2.4). Previously the compound-identifier
 * codegen silently auto-allocated a zero local for an undeclared name, so
 * `x += 1` no-op'd instead of throwing.
 *
 * Declared targets (local / param / module global / outer-scope) keep working.
 */
import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const exports = await compileAndInstantiate(src);
  return ((exports as any).test as () => number)();
}

describe("#1728 — compound assignment to unresolvable reference throws ReferenceError", () => {
  it.each([
    ["+=", "x += 1"],
    ["-=", "x -= 1"],
    ["*=", "x *= 2"],
    ["/=", "x /= 2"],
    ["%=", "x %= 2"],
  ])("undeclared %s throws ReferenceError", async (_op, stmt) => {
    const src = `
export function test(): number {
  try { ${stmt}; return 0; }
  catch (e) { return (e instanceof ReferenceError) ? 1 : 2; }
}`;
    expect(await run(src)).toBe(1);
  });

  it("declared local compound assignment still works", async () => {
    expect(await run(`export function test(): number { let a = 10; a += 5; return a; }`)).toBe(15);
  });

  it("parameter compound assignment still works", async () => {
    expect(
      await run(`function g(n: number): number { n += 3; return n; } export function test(): number { return g(7); }`),
    ).toBe(10);
  });

  it("module-global compound assignment still works", async () => {
    expect(
      await run(`let m = 1; function bump(): void { m += 4; } export function test(): number { bump(); return m; }`),
    ).toBe(5);
  });

  it("string compound assignment still works", async () => {
    expect(await run(`export function test(): number { let s = ""; s += "ab"; return s.length; }`)).toBe(2);
  });
});
