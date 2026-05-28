import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("#1596 Function.prototype.apply/.call on function expressions", () => {
  it("(function(){}).apply(null, [literal]) forwards arguments", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(a: number, b: number, c: number): number {
          return a + b + c;
        }).apply(null, [3, 4, 5]);
      }
    `);
    expect(e.test()).toBe(12);
  });

  it("(function(){}).apply binds arguments.length", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(a: number, b: number, c: number): number {
          return arguments.length;
        }).apply(null, [3, 4, 5]);
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("(function(){}).call(null, a, b) forwards positional args", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(a: number, b: number): number {
          return a * b;
        }).call(null, 6, 7);
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("(() => {}).apply(null, [literal]) works on arrow functions", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return ((a: number, b: number): number => a - b).apply(null, [10, 3]);
      }
    `);
    expect(e.test()).toBe(7);
  });

  it(".apply with empty args array invokes with zero args", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(): number { return 99; }).apply(null, []);
      }
    `);
    expect(e.test()).toBe(99);
  });

  it("nested .call inside expression", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const x = (function(a: number): number { return a + 1; }).call(null, 41);
        return x;
      }
    `);
    expect(e.test()).toBe(42);
  });

  // Module-level IIFE-with-trailing-call pattern: (function(){...}.apply(...)).
  // The outer parens wrap the whole call expression (not the function literal).
  // Before the fix this ExpressionStatement was silently dropped from
  // `__module_init` because the collector only matched bare
  // `isCallExpression`/`isNewExpression`, never a `ParenthesizedExpression`
  // around them. This is the shape test262 generates for the
  // `spread-sngl-literal.js` / `spread-mult-literal.js` family.
  // Module-level IIFE-with-trailing-call shape `(function(){...}.apply(...))`
  // — the test262 spread-sngl-literal.js / spread-mult-literal.js family's
  // exact AST. The outer parens wrap the whole call expression, not the
  // function literal. Before the fix this ExpressionStatement was silently
  // dropped from `__module_init` because the collector only matched bare
  // `isCallExpression`/`isNewExpression`, never a `ParenthesizedExpression`
  // around them. We use a plain CallExpression-on-property-access shape with
  // an outer paren around the whole statement, matching the test262 source.
  it("module-level outer-paren CallExpression — was silently dropped from __module_init", async () => {
    const e = await compileAndRun(`
      var callCount = 0;
      function bump(): void { callCount += 1; }
      (bump());
      export function test(): number { return callCount; }
    `);
    expect(e.test()).toBe(1);
  });

  it("module-level outer-paren MemberCall — was silently dropped from __module_init", async () => {
    // (obj.method()) — parens around a property-access call. Same dropped-statement
    // bug as above for the test262 (function(){}.apply(...)) shape.
    const e = await compileAndRun(`
      var callCount = 0;
      const obj = { bump(): void { callCount += 1; } };
      (obj.bump());
      export function test(): number { return callCount; }
    `);
    expect(e.test()).toBe(1);
  });
});
