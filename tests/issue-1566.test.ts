/**
 * #1566 — ToNumber(Symbol) must throw TypeError (§7.1.4).
 *
 * Per ECMA-262 §7.1.4 ToNumber: "If argument is a Symbol, throw a TypeError
 * exception." Symbols are lowered to i32 ids in this compiler, so a numeric
 * coercion (`+sym`, `Number(sym)`) previously emitted `f64.convert_i32_s`
 * (or a pass-through), silently turning the id into a number.
 *
 * Fix: detect the symbol TS type at the unary-`+` (`src/codegen/expressions/
 * unary.ts`) and `Number(x)` (`src/codegen/expressions/calls.ts`) ToNumber
 * sites and throw a TypeError instance instead of coercing.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #1566 — ToNumber(Symbol) throws TypeError", () => {
  it("+Symbol() throws a TypeError instance", async () => {
    const ex = await compileToWasm(`
export function test(): string {
  try { const x = +Symbol('x'); return 'no-throw'; }
  catch (e: any) { return e instanceof TypeError ? 'TypeError' : 'other'; }
}`);
    expect(ex.test!()).toBe("TypeError");
  });

  it("+s (s: symbol) throws a TypeError instance", async () => {
    const ex = await compileToWasm(`
export function test(): string {
  const s: symbol = Symbol();
  try { const x = +s; return 'no-throw'; }
  catch (e: any) { return e instanceof TypeError ? 'TypeError' : 'other'; }
}`);
    expect(ex.test!()).toBe("TypeError");
  });

  it("Number(Symbol()) throws a TypeError instance", async () => {
    const ex = await compileToWasm(`
export function test(): string {
  try { const x = Number(Symbol('x')); return 'no-throw'; }
  catch (e: any) { return e instanceof TypeError ? 'TypeError' : 'other'; }
}`);
    expect(ex.test!()).toBe("TypeError");
  });

  it("does not regress numeric ToNumber: +'42' === 42", async () => {
    const ex = await compileToWasm("export function test(): number { return +'42'; }");
    expect(ex.test!()).toBe(42);
  });

  it("does not regress Number('3.5') === 3.5", async () => {
    const ex = await compileToWasm("export function test(): number { return Number('3.5'); }");
    expect(ex.test!()).toBe(3.5);
  });
});
