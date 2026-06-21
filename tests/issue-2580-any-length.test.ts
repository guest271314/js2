// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2580 M1a) `.length` on a statically-`any`/`unknown` receiver in HOST mode.
//
// Before M1a, `.length` on an `any` receiver fell through to a NUMERIC coercion:
// a plain object's absent `length` read back as `0` (so `obj.length === undefined`
// was `false` and `typeof obj.length` was a bogus `"number"`/`"boolean"`). M1a
// routes the `any`-receiver `.length` through a uniform-externref read: a runtime
// `ref.test` against the registered vec types reads the array length (boxed), and
// the non-vec miss calls `__extern_get(recv, "length")` which returns the real
// property value or JS `undefined` when absent. The result is an externref that
// the existing numeric-coercion path unboxes at arithmetic/comparison consumers.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  }
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // setExports wires host closures back to the instance (no-op when absent).
  (imports as { setExports?: (e: WebAssembly.Exports) => void }).setExports?.(instance.exports);
  return (instance.exports as { run: () => unknown }).run();
}

describe("#2580 .length on an any receiver", () => {
  it("plain object absent .length === undefined (was 0)", async () => {
    expect(await run(`const o: any = {}; export function run(): boolean { return o.length === undefined; }`)).toBe(1);
  });

  it("typeof plain-object absent .length is 'undefined' (was 'number')", async () => {
    expect(await run(`const o: any = {}; export function run(): string { return typeof o.length; }`)).toBe("undefined");
  });

  it("object with own props but no length → undefined", async () => {
    expect(
      await run(`const o: any = { x: 1 }; export function run(): boolean { return o.length === undefined; }`),
    ).toBe(1);
  });

  it("array-as-any .length reads the real numeric length", async () => {
    expect(await run(`const o: any = [1, 2, 3]; export function run(): boolean { return o.length === 3; }`)).toBe(1);
  });

  it("String(array-as-any .length) stringifies the number, not 'undefined'", async () => {
    expect(await run(`const o: any = [1, 2]; export function run(): string { return String(o.length); }`)).toBe("2");
  });

  it("array-like plain object with an own .length property reads it", async () => {
    expect(
      await run(`const o: any = { length: 5 }; export function run(): number { return o.length as number; }`),
    ).toBe(5);
  });

  it("string-as-any .length reads the string length", async () => {
    expect(await run(`const o: any = "abc"; export function run(): number { return o.length as number; }`)).toBe(3);
  });

  it("arithmetic consumer coerces the boxed length back to a number", async () => {
    expect(await run(`const o: any = [1, 2, 3]; export function run(): number { return o.length * 2; }`)).toBe(6);
  });

  it("for-loop bound over an any-receiver length iterates correctly", async () => {
    expect(
      await run(
        `const o: any = [10, 20, 30]; export function run(): number { let s = 0; for (let i = 0; i < o.length; i++) s++; return s; }`,
      ),
    ).toBe(3);
  });

  it("truthiness: empty-object .length is falsy, array .length is truthy", async () => {
    expect(await run(`const o: any = {}; export function run(): number { if (o.length) return 1; return 0; }`)).toBe(0);
    expect(
      await run(`const o: any = [1, 2]; export function run(): number { if (o.length) return 1; return 0; }`),
    ).toBe(1);
  });

  // Typed `.length` hot-path must remain correct (byte-identical lowering).
  it("typed number[].length unchanged", async () => {
    expect(await run(`const o: number[] = [1, 2, 3]; export function run(): number { return o.length; }`)).toBe(3);
  });

  it("typed string.length unchanged", async () => {
    expect(await run(`const o: string = "abc"; export function run(): number { return o.length; }`)).toBe(3);
  });

  it("arguments.length unchanged (typed guard arm)", async () => {
    expect(
      await run(
        `function f(): number { return arguments.length; } export function run(): number { return f(1, 2, 3); }`,
      ),
    ).toBe(3);
  });
});
