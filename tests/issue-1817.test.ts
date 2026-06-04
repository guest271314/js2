import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

// #1817 — `>>>` (unsigned right shift) must yield an unsigned (ToUint32) result.
// The i32-pure fast path (compileI32BinaryOp / tryFlattenBinaryChain) returned a
// bare i32 for `>>>` that the consumer widened with the *signed* f64.convert_i32_s,
// so a high-bit result read back negative. `>>>` now always routes through
// compileBitwiseBinaryOp (f64.convert_i32_u). ECMAScript ToUint32 (§7.1.7).

async function run(source: string, opts: Record<string, unknown> = {}): Promise<number> {
  const result = await compile(source, opts);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

describe("#1817 — >>> produces an unsigned result", () => {
  it("(-1 >>> 0) === 4294967295", async () => {
    expect(await run(`export function test(): number { const x = -1; return x >>> 0; }`)).toBe(4294967295);
  });

  it("high-bit value: (-2147483648 >>> 0) === 2147483648", async () => {
    expect(await run(`export function test(): number { const x = -2147483648; return x >>> 0; }`)).toBe(2147483648);
  });

  it("(-8 >>> 1) === 2147483644", async () => {
    expect(await run(`export function test(): number { const x = -8; return x >>> 1; }`)).toBe(2147483644);
  });

  it("positive value unaffected: (16 >>> 2) === 4", async () => {
    expect(await run(`export function test(): number { const x = 16; return x >>> 2; }`)).toBe(4);
  });

  it("fast mode: runtime (-1 >>> 0) === 4294967295", async () => {
    const src = `export function shr(a: number, b: number): number { return a >>> b; } export function test(): number { return shr(-1, 0); }`;
    expect(await run(src, { fast: true })).toBe(4294967295);
  });

  it("fast-mode chain a >>> b >>> c stays unsigned", async () => {
    const src = `export function shr2(a: number, b: number, c: number): number { return a >>> b >>> c; } export function test(): number { return shr2(-1, 0, 0); }`;
    expect(await run(src, { fast: true })).toBe(4294967295);
  });

  it("native i32 annotation: (-1 >>> 0) === 4294967295", async () => {
    const src = `type i32 = number; export function shr(x: i32): number { return x >>> 0; } export function test(): number { return shr(-1); }`;
    expect(await run(src)).toBe(4294967295);
  });

  it("nested chain keeps fast path: ((-1 >>> 4) & 255) === 255", async () => {
    expect(await run(`export function test(): number { const x = -1; return (x >>> 4) & 255; }`)).toBe(255);
  });
});
