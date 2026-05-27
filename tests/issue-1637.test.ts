import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1637 — implicit Symbol→string coercion must throw TypeError (§7.1.17 ToString).
// Explicit String()/.toString() on a Symbol is allowed and is out of scope here;
// these tests pin the implicit-coercion throw paths the issue targets.
describe("Symbol implicit string coercion throws TypeError (#1637)", () => {
  it("template literal substitution of a Symbol throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        try {
          const s = \`\${Symbol("x")}\`;
          return false;
        } catch (e) {
          return e instanceof TypeError;
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("string + Symbol concatenation throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        try {
          const s = "v=" + Symbol("x");
          return false;
        } catch (e) {
          return e instanceof TypeError;
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Symbol + string concatenation throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        try {
          const s = Symbol("x") + "=v";
          return false;
        } catch (e) {
          return e instanceof TypeError;
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("non-Symbol concat and templates are unaffected", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return "n=" + 5 + ", b=" + true + \`, t=\${42}\`;
      }
    `);
    expect(exports.test()).toBe("n=5, b=true, t=42");
  });

  it("Symbol.for with a string key still works", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        return Symbol.for("abc") === Symbol.for("abc");
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Symbol.keyFor on an unregistered Symbol returns undefined", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        return Symbol.keyFor(Symbol("x")) === undefined;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
