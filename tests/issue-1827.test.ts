import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

// #1827 — BigInt × Number loose (in)equality must use EXACT mathematical-value
// equality (ECMAScript §7.2.13), not an f64 collapse. A BigInt outside ±2^53
// rounds to a nearby f64, so `f64.eq` wrongly reports e.g.
// `9007199254740993n == 9007199254740992` as true.

async function run(source: string, ...args: unknown[]): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: (...a: unknown[]) => number }).test(...args);
}

describe("#1827 — BigInt == Number exact equality", () => {
  it("9007199254740993n == 9007199254740992 is false (no f64 rounding)", async () => {
    // runtime operands defeat constant folding
    const src = `export function test(b: bigint, n: number): number { return (b == n) ? 1 : 0; }`;
    expect(await run(src, 9007199254740993n, 9007199254740992)).toBe(0);
  });

  it("equal integral values compare true", async () => {
    const src = `export function test(b: bigint, n: number): number { return (b == n) ? 1 : 0; }`;
    expect(await run(src, 12n, 12)).toBe(1);
  });

  it("non-integral Number is never == BigInt", async () => {
    const src = `export function test(b: bigint, n: number): number { return (b == n) ? 1 : 0; }`;
    expect(await run(src, 12n, 12.5)).toBe(0);
  });

  it("!= is the negation", async () => {
    const src = `export function test(b: bigint, n: number): number { return (b != n) ? 1 : 0; }`;
    expect(await run(src, 9007199254740993n, 9007199254740992)).toBe(1);
    expect(await run(src, 12n, 12)).toBe(0);
  });

  it("constant-folded forms also correct", async () => {
    expect(
      await run(`export function test(): number { return (9007199254740993n == 9007199254740992) ? 1 : 0; }`),
    ).toBe(0);
    expect(await run(`export function test(): number { return (12n == 12) ? 1 : 0; }`)).toBe(1);
  });
});
