// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2904 — fixed-arity array destructuring of an `any`-typed (externref) source
 * must NOT leak the JS-host `env::__array_from_iter_n` import under
 * `--target standalone`. A leaked `env::` import breaks zero-import
 * instantiation, so every test in the ~889-case cluster failed standalone.
 *
 * Fix: `destructureParamArray`'s externref fallback now drains the source
 * through the native `__array_from_iter_n` defined function
 * (`ensureNativeArrayFromIterN`, iterator-native.ts), which reuses the existing
 * native `__iterator` / `__iterator_next` runtime — no host import. JS-host mode
 * keeps the import (byte-identical).
 *
 * Both the variable-declaration path (`const [a,b]=x`) and the array-pattern
 * param path (`function f([a,b]: any)`) delegate to `destructureParamArray`, so
 * one fix covers both.
 *
 * NOTE on scope: `any + any` arithmetic on values read out of an `any` array
 * (`x[0] + x[1]`, and equivalently destructured boxed bindings) is a separate,
 * pre-existing standalone substrate gap (the boxed-number value-read path —
 * project_standalone_any_string_value_read_substrate). These cases use
 * individual value reads / `any * number` arithmetic, which exercise the drain
 * + bind without depending on that orthogonal gap.
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

describe("#2904 fixed-arity array destructuring drains natively (no __array_from_iter_n)", () => {
  it("decl: two bindings, three-element any source — positional values", async () => {
    expect(
      await runStandalone(`export function test(): number { const x:any=[10,20,30]; const [a,b]=x; return a*10+b; }`),
    ).toBe(120);
  });

  it("decl: three bindings, three-element any source", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const x:any=[10,20,30]; const [a,b,c]=x; return a*100+b*10+c; }`,
      ),
    ).toBe(1230);
  });

  it("decl: out-of-length binding default fires (short source)", async () => {
    expect(
      await runStandalone(`export function test(): number { const x:any=[5]; const [a,b=9]=x; return a*10+b; }`),
    ).toBe(59);
  });

  it("decl: elision skips an element", async () => {
    expect(await runStandalone(`export function test(): number { const x:any=[7,8]; const [,b]=x; return b; }`)).toBe(
      8,
    );
  });

  it("array-pattern param of any drains natively", async () => {
    expect(
      await runStandalone(
        `function f([a,b]: any): number { return a*10+b; } export function test(): number { return f([3,4]); }`,
      ),
    ).toBe(34);
  });

  it("decl: more than the drain's initial capacity (>4 elements exercises grow)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const x:any=[1,2,3,4,5,6]; const [a,b,c,d,e,f]=x; return a*100000+b*10000+c*1000+d*100+e*10+f; }`,
      ),
    ).toBe(123456);
  });

  it("decl: neither binding is undefined when source has enough elements", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const x:any=[10,20,30]; const [a,b]=x; return (a===undefined?1:0)+(b===undefined?1:0); }`,
      ),
    ).toBe(0);
  });
});
