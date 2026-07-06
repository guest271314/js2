// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2933 — standalone `JSON.stringify` as a VALUE (fixed 1-arg compact form).
//
// Reading `JSON.stringify` AS A VALUE under `--target standalone`
// (`const f: any = JSON.stringify; f({a:1})`) previously refused with the
// `#1907`/`#1888 S6-b` "built-in static property value read is not supported"
// compile error. The standalone CALL path already serialises host-free via the
// native `__json_stringify_root` (`anyref -> ref $AnyString`); this slice wires
// that SAME entry into `ensureStandaloneBuiltinStaticMethodClosure` so the
// reified value calls identically. Objects/numbers/strings serialise correctly;
// an array reaching the closure through `any`-boxing inherits the SAME
// pre-existing substrate limitation the direct `JSON.stringify(anyVar)` path
// has (top-level any-boxed array -> "null") — the closure adds no new divergence.
//
// The value read reifies zero host imports (asserted below), so it is a
// standalone-floor-visible flip: CE (refusal) -> runs and returns the JSON
// string.

async function lenStandalone(body: string): Promise<number> {
  const r = await compile(`export function test(): number { ${body} }`, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No host imports — pure standalone Wasm.
  expect((r.imports ?? []).map((i) => `${i.module}::${i.name}`).filter((l) => l.startsWith("env::"))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function idStandalone(body: string): Promise<number> {
  // nativeStrings harness (matches #2963) for identity / ref-equality checks —
  // reads keep their inferred builtin-fn ref type (no `any`-boxing, which would
  // round-trip through externref and defeat ref identity).
  const r = await compile(`export function test(): number { ${body} }`, {
    target: "standalone",
    nativeStrings: true,
  });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function compilesHost(body: string): Promise<void> {
  // Sanity that the SAME read under gc/host still compiles (dual-mode intact).
  const r = await compile(`export function test(): string { ${body} }`, {});
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
}

describe("#2933 — standalone JSON.stringify static value read", () => {
  it("JSON.stringify as a value serialises an object (was a compile refusal)", async () => {
    // {"a":1} -> 7 chars.
    expect(await lenStandalone(`const f: any = JSON.stringify; const s: string = f({ a: 1 }); return s.length;`)).toBe(
      7,
    );
  });

  it("value read produces the SAME string as the direct call", async () => {
    // First char '{' === 123.
    expect(
      await lenStandalone(`const f: any = JSON.stringify; const s: string = f({ a: 1 }); return s.charCodeAt(0);`),
    ).toBe(123);
  });

  it("serialises a nested object", async () => {
    // {"a":{"b":2}} -> 13 chars.
    expect(
      await lenStandalone(`const f: any = JSON.stringify; const s: string = f({ a: { b: 2 } }); return s.length;`),
    ).toBe(13);
  });

  it("serialises a number argument", async () => {
    // "42" -> 2 chars.
    expect(await lenStandalone(`const f: any = JSON.stringify; const s: string = f(42); return s.length;`)).toBe(2);
  });

  it("serialises a string argument (quotes added)", async () => {
    // '"hi"' -> 4 chars.
    expect(await lenStandalone(`const f: any = JSON.stringify; const s: string = f("hi"); return s.length;`)).toBe(4);
  });

  it("identity is singleton-stable (=== holds across reads)", async () => {
    // Inferred typing keeps the builtin-fn ref (no `any`-boxing) so `===` is a
    // ref compare against the module-level singleton (#2963).
    expect(await idStandalone(`const a = JSON.stringify, b = JSON.stringify; return a === b ? 1 : 0;`)).toBe(1);
  });

  it("the reified value is distinct from a different builtin static method", async () => {
    expect(await idStandalone(`const a: any = JSON.stringify, b: any = Reflect.get; return a === b ? 1 : 0;`)).toBe(0);
  });

  it("does not disturb the direct JSON.stringify call path", async () => {
    // {"a":1} -> 7 chars via the direct call (regression guard).
    expect(await lenStandalone(`const s: string = JSON.stringify({ a: 1 }); return s.length;`)).toBe(7);
  });

  it("host mode still compiles the value read (dual-mode intact)", async () => {
    await compilesHost(`const f: any = JSON.stringify; return f({ a: 1 });`);
  });
});
