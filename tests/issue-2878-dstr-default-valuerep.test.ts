// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2878 Class A — object-destructuring-with-default value-representation mismatch.
//
// Under `--target standalone`, a heterogeneous / dynamic object literal boxes
// every field to `externref`, so a binding element's *value-present* arm read a
// boxed field (externref) while the binding LOCAL was a scalar (f64/i32) — the
// arm stored the externref straight into the scalar local:
//   local.set $v (local.get $boxedField)   ;; f64 <- externref  -> invalid Wasm
// V8 rejected the module: `local.set[0] expected type f64, found ... externref`
// (the whole `test`/`inner`/`fn` body-shape invalid-Wasm cluster).
//
// Fix: `emitDefaultValueCheck` now coerces the value-present arm to the binding
// local's ACTUAL declared type (`getLocalType`), not `targetType` — mirroring the
// default arm (`emitDefaultIntoLocal`). Coercing a boxed number externref -> f64
// unboxes it correctly (no NaN, since a scalar local only ever binds a numeric
// property). Byte-inert for the gc/host lane (there the struct field type already
// matches the local, so the coercion is a no-op path).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function runHost(src: string): Promise<number> {
  const r = await compile(src);
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as { test(): number }).test();
}

describe("#2878 Class A — object destructuring default value-rep", () => {
  it("scalar binding over a boxed (dynamic) field: no invalid Wasm, default not fired", async () => {
    // The minimal repro: `{ u: 0 }` boxes field u to externref; binding `v` is
    // f64. Property present -> default `counter()` must NOT fire; v === 0.
    const src = `
      var c = 0;
      function counter(): number { c += 1; return 99; }
      export function test(): number {
        const { u: v = counter() } = { u: 0 };
        return v * 1000 + c; // expect 0 (v=0, c=0)
      }`;
    expect(await runStandalone(src)).toBe(0);
    expect(await runHost(src)).toBe(0); // host/standalone behaviour parity
  });

  it("scalar binding takes its default when the property is genuinely absent", async () => {
    const src = `
      function mk(): number { return 7; }
      export function test(): number {
        const { u: v = mk() } = {} as any;
        return v; // property absent -> default fires -> 7
      }`;
    expect(await runStandalone(src)).toBe(7);
    expect(await runHost(src)).toBe(7);
  });

  it("boolean (i32) binding over a boxed field is valid Wasm and reads through", async () => {
    const src = `
      export function test(): number {
        const { b: flag = true } = { b: false } as any;
        return flag ? 1 : 0; // present false -> flag=false -> 0
      }`;
    expect(await runStandalone(src)).toBe(0);
    expect(await runHost(src)).toBe(0);
  });

  it("multi-binding heterogeneous object literal compiles to valid Wasm (no invalid-module CE)", async () => {
    // The shape from const/dstr/obj-ptrn-prop-id-init-skipped.js. Pre-fix this
    // was rejected by V8 with `local.set expected f64, found externref`. We
    // assert VALIDITY + that no default fires (initCount stays 0) — the exact
    // second-field VALUE read is gated on the separate dynamic-object numeric
    // read bug (#2849), so this test deliberately does not assert it.
    const src = `
      var initCount = 0;
      function counter(): number { initCount += 1; return -1; }
      export function test(): number {
        const { u: v = counter(), a: w = counter() } = { u: 0, a: 5 } as any;
        return v + initCount * 100; // v=0, initCount=0 -> 0 (no default fired)
      }`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    expect(await runStandalone(src)).toBe(0);
    expect(await runHost(src)).toBe(0);
  });
});
