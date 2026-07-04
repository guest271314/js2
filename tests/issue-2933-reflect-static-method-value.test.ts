// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2933 — standalone namespace static-METHOD VALUE reads (fixed-arity Reflect.*).
//
// Reading a `Reflect.*` static method AS A VALUE under `--target standalone`
// (`const f: any = Reflect.get; f(o, "k")`) previously refused with the
// `#1907`/`#1888 S6-b` "built-in static property value read is not supported"
// compile error. The standalone CALL path already backs the fixed-arity
// `Reflect.get`/`has`/`set`/`ownKeys` with a simple externref/i32 native
// (`__extern_get` / `__extern_has` / `__reflect_set` / `__object_keys`); this
// slice wires those SAME natives into `ensureStandaloneBuiltinStaticMethodClosure`
// so the reified value calls identically. The variadic (`Math.max`) and
// native-`$AnyValue`-return (`JSON.stringify`) methods stay refused (need
// variadic / anyref-boundary closure work — tracked on #2933's remaining scope).

async function runStandalone(body: string): Promise<number> {
  const r = await compile(`export function test(): number { ${body} }`, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No host imports — pure standalone Wasm.
  expect((r.imports ?? []).map((i) => `${i.module}::${i.name}`).filter((l) => l.startsWith("env::"))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function runStandaloneNS(body: string): Promise<number> {
  // nativeStrings harness (matches #2963) for identity / ref-equality checks.
  const r = await compile(`export function test(): number { ${body} }`, {
    target: "standalone",
    nativeStrings: true,
  });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2933 — standalone Reflect.* static-method value reads", () => {
  it("Reflect.get as a value reads the property (was a compile refusal)", async () => {
    expect(await runStandalone(`const o: any = { k: 42 }; const f: any = Reflect.get; return f(o, "k");`)).toBe(42);
  });

  it("Reflect.has as a value returns true for a present key", async () => {
    expect(await runStandalone(`const o: any = { k: 42 }; const f: any = Reflect.has; return f(o, "k") ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("Reflect.has as a value returns false for an absent key", async () => {
    expect(await runStandalone(`const o: any = { k: 42 }; const f: any = Reflect.has; return f(o, "z") ? 1 : 0;`)).toBe(
      0,
    );
  });

  it("Reflect.set as a value writes the property", async () => {
    expect(await runStandalone(`const o: any = { k: 1 }; const f: any = Reflect.set; f(o, "k", 7); return o.k;`)).toBe(
      7,
    );
  });

  it("Reflect.ownKeys as a value returns the own keys", async () => {
    expect(
      await runStandalone(
        `const o: any = { a: 1, b: 2 }; const f: any = Reflect.ownKeys; const ks: any = f(o); return ks.length;`,
      ),
    ).toBe(2);
  });

  it("the Reflect.get CALL path is unregressed", async () => {
    expect(await runStandalone(`const o: any = { k: 5 }; return Reflect.get(o, "k");`)).toBe(5);
  });

  it("reified Reflect.get is identity-stable (single function object)", async () => {
    expect(await runStandaloneNS(`const a = Reflect.get, b = Reflect.get; return a === b ? 1 : 0;`)).toBe(1);
  });

  it("distinct Reflect methods are NOT identity-equal", async () => {
    expect(await runStandaloneNS(`const a: any = Reflect.get, b: any = Reflect.has; return a === b ? 0 : 1;`)).toBe(1);
  });
});

describe("#2933 — deferred namespace static-method value reads still refuse (scope boundary)", () => {
  it("JSON.stringify as a value still refuses (needs anyref-boundary closure)", async () => {
    const r = await compile(
      `export function test(): number { const f: any = JSON.stringify; return f({ a: 1 }) ? 1 : 0; }`,
      {
        target: "standalone",
      },
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toContain("JSON.stringify");
  });

  it("Math.max as a value still refuses (variadic — split follow-up)", async () => {
    const r = await compile(`export function test(): number { const g: any = Math.max; return g(1, 2, 3); }`, {
      target: "standalone",
    });
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toContain("Math.max");
  });
});
