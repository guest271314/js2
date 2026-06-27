/**
 * Tests for #2742 group (d): builtin function `.length` must be a non-enumerable
 * own data property per ES §17.
 *
 * Group (a)/(b)/(c) (generic-receiver ToString coercion) are out-of-scope for
 * this PR — they are substrate-gated. Only group (d) is implemented here.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any)[fn](...args);
}

describe("#2742 group (d): builtin function .length is non-enumerable", () => {
  it("String.prototype.charAt.hasOwnProperty('length') returns true", async () => {
    const src = `
      export function test(): number {
        return String.prototype.charAt.hasOwnProperty('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("String.prototype.charAt.propertyIsEnumerable('length') returns false (DontEnum)", async () => {
    const src = `
      export function test(): number {
        return String.prototype.charAt.propertyIsEnumerable('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("String.prototype.charCodeAt.propertyIsEnumerable('length') returns false", async () => {
    const src = `
      export function test(): number {
        return String.prototype.charCodeAt.propertyIsEnumerable('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("String.prototype.indexOf.propertyIsEnumerable('length') returns false", async () => {
    const src = `
      export function test(): number {
        return String.prototype.indexOf.propertyIsEnumerable('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("String.prototype.substring.propertyIsEnumerable('length') returns false", async () => {
    const src = `
      export function test(): number {
        return String.prototype.substring.propertyIsEnumerable('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("for-in on String.prototype.charAt does not enumerate 'length'", async () => {
    const src = `
      export function test(): number {
        var count = 0;
        for (var p in String.prototype.charAt) {
          if (p === 'length') count++;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("user-defined function own property is still enumerable when added dynamically", async () => {
    // Regression guard: regular own properties on Wasm structs must remain enumerable.
    const src = `
      export function test(): number {
        var obj: any = {};
        obj.x = 42;
        return obj.propertyIsEnumerable('x') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });
});
