import { describe, expect, it } from "vitest";
import { compileValid, instantiate } from "./real-world-helpers.js";

/**
 * Real-world ES module import / export wiring.
 *
 * test262 runs each file as a standalone script/module and never exercises
 * the *bundler-facing* surface real apps depend on: a module that re-exports,
 * aliases, mixes default + named exports, or pulls symbols in from another
 * package. These assert that idiomatic module source compiles to a valid Wasm
 * module and that the exported functions are callable.
 */
describe("real-world: ES modules (import / export)", () => {
  it("compiles mixed default + named exports and runs them", async () => {
    const exports = await instantiate(`
      export const TAX_RATE = 0.2;
      export function withTax(price: number): number {
        return price * (1 + TAX_RATE);
      }
      export default function net(gross: number): number {
        return gross / (1 + TAX_RATE);
      }
    `);
    expect(exports.withTax(100)).toBe(120);
  });

  it("compiles export lists with `as` aliases and runs the alias", async () => {
    const exports = await instantiate(`
      function multiply(a: number, b: number): number {
        return a * b;
      }
      function subtract(a: number, b: number): number {
        return a - b;
      }
      export { multiply as product, subtract };
    `);
    expect(exports.product(4, 5)).toBe(20);
    expect(exports.subtract(9, 4)).toBe(5);
  });

  it("compiles a named import from a bare package specifier", async () => {
    // `import { Hono } from "hono"` is rewritten to a host-import stub by the
    // import resolver; the module must still produce a valid binary.
    await compileValid(`
      import { Hono } from "hono";
      export function makeApp(): number {
        const app = new Hono();
        return 1;
      }
    `);
  });

  it("compiles a default import from a bare package specifier", async () => {
    await compileValid(`
      import express from "express";
      export function makeApp(): number {
        const app = express();
        return 1;
      }
    `);
  });

  it("compiles a namespace import from a node: builtin", async () => {
    await compileValid(`
      import * as path from "node:path";
      export function join2(a: string, b: string): string {
        return path.join(a, b);
      }
    `);
  });

  it("compiles renamed named imports", async () => {
    await compileValid(
      `
      import { readFileSync as read } from "node:fs";
      export function load(p: string): string {
        return read(p, "utf8");
      }
    `,
      { allowFs: true },
    );
  });

  it("compiles a module that both imports and re-exports", async () => {
    await compileValid(`
      import { useState } from "react";
      export { useState };
      export function Counter(): number {
        const [count] = useState(0);
        return count;
      }
    `);
  });
});
