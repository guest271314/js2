import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1732 (Symbol-coercion sub-fix) — Math.* methods run ToNumber on their
// arguments (§7.1.4). ToNumber of a Symbol MUST throw TypeError (step 5).
// Symbols lower to i32 ids, so the f64-hint coercion path used to leak the id
// as a plain number instead of throwing (e.g. `Math.abs(Symbol())` returned the
// raw symbol counter). `compileMathCall` now detects a symbol-typed argument and
// throws, mirroring how `Number(Symbol())` is handled.

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.js", allowJs: true, skipSemanticDiagnostics: true });
  if (!r.success) throw new Error("CE: " + (r.errors[0]?.message ?? "unknown"));
  const built = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  (built as { setExports?: (e: WebAssembly.Exports) => void }).setExports?.(instance.exports);
  return (instance.exports as { test: () => unknown }).test();
}

// Returns -1 when a TypeError is thrown (the correct spec result), -2 for any
// other error, or the raw numeric result when nothing throws (the bug).
const guard = (call: string) =>
  `export function test() { try { return ${call}; } catch (e) { return e instanceof TypeError ? -1 : -2; } }`;

describe("issue #1732 — Math.* ToNumber(Symbol) throws TypeError", () => {
  for (const call of [
    "Math.abs(Symbol())",
    "Math.floor(Symbol())",
    "Math.ceil(Symbol())",
    "Math.sqrt(Symbol())",
    "Math.trunc(Symbol())",
    "Math.round(Symbol())",
    "Math.sign(Symbol())",
    "Math.max(1, Symbol())",
    "Math.max(Symbol(), 1)",
    "Math.min(Symbol(), 9)",
    "Math.pow(2, Symbol())",
    "Math.clz32(Symbol())",
  ]) {
    it(`${call} throws TypeError`, async () => {
      expect(await run(guard(call))).toBe(-1);
    });
  }

  // Regression guard: numeric Math.* paths must be unaffected.
  it("Math.abs(-5) === 5", async () => {
    expect(await run("export function test() { return Math.abs(-5); }")).toBe(5);
  });
  it("Math.max(1,2,3) === 3", async () => {
    expect(await run("export function test() { return Math.max(1, 2, 3); }")).toBe(3);
  });
  it("Math.min(4,2,8) === 2", async () => {
    expect(await run("export function test() { return Math.min(4, 2, 8); }")).toBe(2);
  });
  it("Math.round(2.6) === 3", async () => {
    expect(await run("export function test() { return Math.round(2.6); }")).toBe(3);
  });
  it("Math.pow(2,10) === 1024", async () => {
    expect(await run("export function test() { return Math.pow(2, 10); }")).toBe(1024);
  });
  it("Math.max(NaN, 1) is NaN (NaN propagation intact)", async () => {
    expect(await run("export function test() { return Math.max(NaN, 1); }")).toBeNaN();
  });
});
