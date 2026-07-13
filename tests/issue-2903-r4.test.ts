// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2903 R4 — standalone TypedArray SCALAR callback HOFs (sub-front 4).
//
// On main, a directly-constructed typed array (`new Uint8Array([...])`) held at
// its static type reached the `compileArrayMethodCall` (array-methods.ts)
// externref arm, which is a `__make_callback` NO-OP STUB in standalone: it
// created the host callback (dropped → the leak), never ran the predicate, and
// pushed `ref.null.extern`. So `u8.find(cb)`/`findIndex`/`forEach`/`some`/
// `every`/`reduce` leaked `env.__make_callback` (host-free instantiation failed)
// AND returned wrong results.
//
// Two independent gaps fixed here (both `ctx.standalone`-gated → gc/wasi
// byte-identical, proven via prove-emit-identity):
//   1. object-runtime.ts — `__extern_get_idx` now reads the packed byte carriers
//      (`i8_byte`/`i16_byte`/`i32_elem`); previously it skipped them, so the
//      native HOF loop `__hof_*` (which reads through it) + `a[i]` + indexOf saw
//      `undefined` at every index for an `any`-held typed array.
//   2. closures.ts + calls.ts — a standalone DIRECT-carrier typed-array scalar
//      HOF is routed to the native `__call_m_<name>_<arity>`/`__hof_<name>`
//      substrate, compiling the callback as a WasmGC closure struct (not the
//      host `__make_callback` bridge).
//
// SIGNEDNESS BOUNDARY (documented, not a regression): both paths read through
// the SAME generic `__extern_get_idx` substrate, which reads `i8_byte`/`i16_byte`
// UNSIGNED — the shared carrier type (Int8Array and Uint8Array both map to
// `i8_byte`/kind `i8`) carries no signedness tag, so a negative Int8/Int16
// element reads as its unsigned bit-pattern regardless of the static type.
// Correct for Uint8/Uint8Clamped/Uint16 (the common case). Int8/Int16 with
// NON-negative values are correct + host-free (a net gain); negative Int8/Int16
// elements read wrong — but those tests were fully broken (host-import leak,
// failed instantiation) before, so nothing regresses. Recovering sub-i32 signed
// reads on the dynamic substrate needs a per-signedness carrier type (deferred).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  return result;
}

function importNames(result: { imports?: { name: string }[] }): string[] {
  return (result.imports ?? []).map((i) => i.name).sort();
}

async function runStandalone(source: string): Promise<number> {
  const result = await compileStandalone(source);
  expect(importNames(result)).toEqual([]); // host-free: no __make_callback
  const { instance } = await WebAssembly.instantiate(result.binary!, {}); // zero imports
  return (instance.exports as { test(): number }).test();
}

describe("#2903 R4 — standalone TypedArray scalar callback HOFs are native + host-free", () => {
  it("static Uint8Array.findIndex runs host-free", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([3, 7, 11, 42, 5]); return a.findIndex((x: number) => x > 10); }`,
      ),
    ).toBe(2);
  });

  it("static Uint8Array.find returns the element (undefined sentinel preserved)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([3, 7, 11, 42, 5]); const r = a.find((x: number) => x > 10); return r === undefined ? -1 : r; }`,
      ),
    ).toBe(11);
  });

  it("static Uint8Array.find not-found is undefined", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([1, 2, 3]); const r = a.find((x: number) => x > 100); return r === undefined ? 42 : -1; }`,
      ),
    ).toBe(42);
  });

  it("static Uint8Array.forEach drives the callback", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([1, 2, 3, 4]); let s = 0; a.forEach((x: number) => { s += x; }); return s; }`,
      ),
    ).toBe(10);
  });

  it("static Uint8Array.reduce (no initial value) seeds from the first element", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([1, 2, 3, 4]); return a.reduce((s: number, x: number) => s + x); }`,
      ),
    ).toBe(10);
  });

  it("static Uint8Array.reduce (with initial value)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([1, 2, 3, 4]); return a.reduce((s: number, x: number) => s + x, 100); }`,
      ),
    ).toBe(110);
  });

  it("static Uint8Array.some / every", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([3, 7, 11]); return (a.some((x: number) => x > 10) && a.every((x: number) => x > 0)) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("untyped (test262-shape) Uint8Array HOF is host-free", async () => {
    expect(
      await runStandalone(
        `function test() { var a = new Uint8Array([3, 7, 11, 42, 5]); return a.findIndex(function (x) { return x > 10; }); }\nexport { test };`,
      ),
    ).toBe(2);
  });

  it("Uint16Array.reduce reads wide packed elements", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint16Array([1000, 2000, 3000]); return a.reduce((s: number, x: number) => s + x, 0); }`,
      ),
    ).toBe(6000);
  });

  it("Int32Array.some reads full 32-bit elements", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Int32Array([100000, 5]); return a.some((x: number) => x > 50000) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("any-held Uint8Array HOF + indexing read the byte carrier (object-runtime __extern_get_idx)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: any = new Uint8Array([3, 7, 11, 42, 5]); return a.findIndex((x: number) => x > 10) + a[2] + a.indexOf(42); }`,
      ),
    ).toBe(2 + 11 + 3);
  });

  it("Int8Array with NON-negative values is host-free + correct", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Int8Array([5, 10, 20]); return a.findIndex((x: number) => x > 7); }`,
      ),
    ).toBe(1);
  });

  it("SIGNEDNESS BOUNDARY: negative Int8 elements read unsigned (documented, was a leak before)", async () => {
    // `-5` stored as packed i8 reads back as 251 (unsigned bit-pattern), so the
    // `x < 0` predicate never matches → undefined. On main this module leaked
    // `env.__make_callback` and failed to instantiate, so this is not a
    // regression — it is a host-free (if signedness-lossy) improvement.
    expect(
      await runStandalone(
        `export function test(): number { const a = new Int8Array([-5, 10, -20]); const r = a.find((x: number) => x < 0); return r === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
