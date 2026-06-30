// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2892 — standalone string-elem native generator `.next().value` reader.
 *
 * A `function*` whose yields are all strings (the #2171 native-string carrier)
 * compiled, but reading its result `.value` as a string via `it.next().value`
 * in `--target standalone` failed wasm validation:
 *
 *   type error in fallthru[0] (expected (ref null 41), got (ref null 35))
 *
 * Root cause: when the iterator `it` is statically opaque (externref — the
 * common shape for `let it = g()`), `.next()` lowers through the OPEN dispatch
 * (`buildNativeGeneratorDispatch`). That block hard-coded its result type to the
 * **f64 IteratorResult singleton**, while each per-generator branch produces its
 * own per-elem result struct (the native-string `__NativeGeneratorResult_refN`).
 * For a string generator the branch's `ref <stringResult>` mismatched the
 * block's `ref <f64Result>`, so the module failed validation. The fix keys the
 * dispatch block type on the generators actually present: one shared result
 * struct → `ref <that idx>` (covers both the numeric singleton AND the single
 * string carrier); distinct result structs / any-carrier → the `eqref` common
 * supertype.
 *
 * This is independent of spills — it reproduces with a zero-spill string
 * generator (`yield "aa"; yield "bbb"`). Every case compiles standalone with
 * ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2892 string-elem generator .next().value reader (standalone)", () => {
  it("reads .value as string and takes .length (the original repro)", async () => {
    expect(
      await runStandalone(`function* g() { yield "aa"; yield "bbb"; }
export function test(): number {
  let it = g();
  let a = (it.next().value as string).length;
  let b = (it.next().value as string).length;
  return a + b;
}`),
    ).toBe(5); // 2 + 3
  });

  it("string === comparison on .next().value", async () => {
    expect(
      await runStandalone(`function* g() { yield "aa"; yield "bbb"; }
export function test(): number {
  let it = g();
  return (it.next().value as string) === "aa" ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("annotated Generator<string> iterator reads .value", async () => {
    expect(
      await runStandalone(`function* g(): Generator<string> { yield "xy"; yield "z"; }
export function test(): number {
  let it: Generator<string> = g();
  return (it.next().value as string).length + (it.next().value as string).length;
}`),
    ).toBe(3); // 2 + 1
  });

  it("string generator with a return value, then .done", async () => {
    expect(
      await runStandalone(`function* g() { yield "aa"; return "zzzz"; }
export function test(): number {
  let it = g();
  let a = (it.next().value as string).length;
  let r = it.next();
  return a + (r.done ? 100 : 0);
}`),
    ).toBe(102); // 2 + 100
  });

  it(".done flips true after exhausting a string generator", async () => {
    expect(
      await runStandalone(`function* g() { yield "aa"; yield "bbb"; }
export function test(): number {
  let it = g();
  it.next();
  it.next();
  return it.next().done ? 1 : 0;
}`),
    ).toBe(1);
  });
});

describe("#2892 regression — numeric .next().value unchanged", () => {
  it("numeric generator .next().value still sums", async () => {
    expect(
      await runStandalone(`function* n() { yield 1; yield 2; }
export function test(): number {
  let it = n();
  return (it.next().value as number) + (it.next().value as number);
}`),
    ).toBe(3);
  });
});
