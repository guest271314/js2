// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1542 — Class method destructured-param default not applied (TypeError
 * "Cannot destructure 'null' or 'undefined'").
 *
 * Root cause: `compileClassesFromStatements` in `declarations.ts` lost the
 * `insideFunction` flag when recursing into block/try/if/loop/switch/labeled
 * statements. A class declaration nested inside e.g. a try block of a
 * function was therefore treated as if at module level and its body was
 * eagerly compiled BEFORE the enclosing function's
 * `hoistFunctionDeclarations` pass had run. When a method parameter default
 * referenced a sibling generator/function declaration in the same scope
 * (e.g. `method([,] = g())`), the lookup against `funcMap` missed and the
 * compiler fell back to `ref.null extern`, causing the destructure-guard to
 * throw at runtime.
 *
 * Fix: propagate `insideFunction` through every recursive descent so nested
 * classes inside any control-flow construct within a function are correctly
 * deferred until the enclosing function compiles its body.
 */
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const exports = (await compileAndInstantiate(source)) as Record<string, () => unknown>;
  return exports.test?.();
}

describe("#1542 class method dstr-param default in block scope", () => {
  it("resolves a sibling generator function from a try-block", async () => {
    const src = `
      export function test(): number {
        try {
          function* g(): any { yield 1; }
          class C {
            method([,] = g()) { return 42; }
          }
          return new C().method() as number;
        } catch (_e) { return -1; }
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("resolves a sibling function from a bare block", async () => {
    const src = `
      export function test(): number {
        {
          function* g(): any { yield 1; }
          class C {
            method([,] = g()) { return 7; }
          }
          return new C().method() as number;
        }
      }
    `;
    expect(await run(src)).toBe(7);
  });

  it("applies an object-pattern default", async () => {
    const src = `
      export function test(): number {
        try {
          class C {
            method({ x = 1 } = {}): number { return x as number; }
          }
          return new C().method() as number;
        } catch (_e) { return -1; }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("does not regress top-level class method defaults", async () => {
    const src = `
      function* g(): any { yield 1; }
      class C {
        method([,] = g()) { return 99; }
      }
      export function test(): number {
        return new C().method() as number;
      }
    `;
    expect(await run(src)).toBe(99);
  });
});
