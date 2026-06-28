import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2750 S1 — single-file `.js` now gets the FULL sound `strict` umbrella
// (`strict: true`), matching both multi-file analysis blocks, instead of only
// the pinned `strictNullChecks` it got under the old `strict: !isJs`.
//
// The risk of `strict: true` for `.js` is that it could start REJECTING
// previously-compiling untyped JS (e.g. via `noImplicitAny`). S1 keeps
// `noImplicitAny: false` precisely so untyped `.js` is NOT rejected — the
// dynamic/`any`/externref path handles it. These tests lock that boundary in:
// untyped single-file `.js` must still compile and run, and the
// soundness-critical `strictNullChecks` guard stays active.
async function runJs(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source, { fileName: "test.js" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn](...args);
}

describe("#2750 S1 — single-file .js gets the sound strict umbrella, noImplicitAny stays OFF", () => {
  it("untyped .js arithmetic still compiles and runs (noImplicitAny OFF under strict:true)", async () => {
    const src = `export function add(a, b) { return a + b; }`;
    expect(await runJs(src, "add", [2, 3])).toBe(5);
  });

  it("untyped .js with an implicit-any local still compiles and runs", async () => {
    const src = `export function sumTo(n) { let acc = 0; for (let i = 1; i <= n; i++) { acc += i; } return acc; }`;
    expect(await runJs(src, "sumTo", [4])).toBe(10);
  });

  it("untyped .js boolean logic still compiles and runs", async () => {
    const src = `export function pick(flag) { return flag ? 1 : 0; }`;
    expect(await runJs(src, "pick", [true])).toBe(1);
    expect(await runJs(src, "pick", [false])).toBe(0);
  });

  it(".js null comparison guard works (strictNullChecks active under strict:true)", async () => {
    // `x === null` must stay a real runtime null check, not be folded away — the
    // #2748 C soundness guard. A typed-any param keeps the dynamic path.
    const src = `export function isNull(x) { return x === null ? 1 : 0; }`;
    expect(await runJs(src, "isNull", [null])).toBe(1);
    expect(await runJs(src, "isNull", [5])).toBe(0);
  });
});
