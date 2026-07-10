// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3014 — a `.forEach` / `.some` call on an `any`-typed receiver must NOT
// first-match a TypedArray extern class and leak `env::Uint8ClampedArray_forEach`
// / `env::Uint8ClampedArray_some` under `--target standalone`.
//
// Defect: `tryExternClassMethodOnAny` resolves an `any`-receiver method call by
// first-match iteration over `ctx.externClasses`. Every TypedArray extern class
// (Uint8ClampedArray, Int8Array, …) declares `forEach`/`some` with an
// all-externref signature, so when a TypedArray registration is present the
// iteration binds `f.forEach(cb)` to `Uint8ClampedArray_forEach` — a host import
// the standalone runtime cannot satisfy (the import name is a pure routing
// artifact; the receiver is not a Uint8ClampedArray). Round-6 leak analysis
// found 16 execution-verified sole-import standalone passes leaking this import
// (all `Array/prototype/{forEach,some}` length-overridden-to-0 subclass tests).
//
// Fix: mirror the `.slice` (#1062) and `.replace`/`.replaceAll` (#1712)
// ambiguity refusals — refuse extern-class dispatch for `forEach`/`some` and let
// the receiver resolve by its real runtime shape.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function buildStandalone(body: string): Promise<{ result: number; envImports: string[] }> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const result = (instance.exports as { test(): number }).test();
  return { result, envImports };
}

async function buildHost(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as { test(): number }).test();
}

// The 16 leaking test262 rows are `f = new foo()` with `foo.prototype = Array`,
// `f.length` overridden to 0 — the callback never fires, so the observable is
// that the call is host-free AND produces the spec-correct no-iteration result.
const ARRAYLIKE_FOREACH =
  "foo.prototype = new Array(1, 2, 3); function foo() {} var f = new foo(); f.length = 0; var c = 0; function cb() { c++; } f.forEach(cb); return c;";
const ARRAYLIKE_SOME =
  "foo.prototype = new Array(1, 2, 3); function foo() {} var f = new foo(); f.length = 0; function cb() { return true; } return f.some(cb) ? 1 : 0;";

describe("#3014 — any-receiver .forEach/.some is host-import-free (no Uint8ClampedArray_* leak)", () => {
  it("array-like .forEach (length 0) does not leak Uint8ClampedArray_forEach", async () => {
    const { result, envImports } = await buildStandalone(ARRAYLIKE_FOREACH);
    expect(envImports).not.toContain("Uint8ClampedArray_forEach");
    expect(envImports).toEqual([]);
    expect(result).toBe(0); // length 0 → callback never called
  });

  it("array-like .some (length 0) does not leak Uint8ClampedArray_some", async () => {
    const { result, envImports } = await buildStandalone(ARRAYLIKE_SOME);
    expect(envImports).not.toContain("Uint8ClampedArray_some");
    expect(envImports).toEqual([]);
    expect(result).toBe(0); // length 0 → some returns false
  });

  it("host (gc) mode still iterates a real array via .forEach on an any receiver", async () => {
    const result = await buildHost(
      "var f: any = [10, 20, 30]; var c = 0; function cb() { c++; } f.forEach(cb); return c;",
    );
    expect(result).toBe(3);
  });

  it("host (gc) mode .some on an any receiver returns the spec-correct result", async () => {
    const result = await buildHost(
      "var f: any = [1, 2, 3]; function cb(v: any) { return v > 2; } return f.some(cb) ? 1 : 0;",
    );
    expect(result).toBe(1);
  });
});
