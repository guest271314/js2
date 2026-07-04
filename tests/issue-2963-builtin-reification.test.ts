// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2963 — reified builtin static methods are IDENTITY-STABLE first-class values.
 *
 * A builtin static method read AS A VALUE under `--target standalone`
 * (`const f = Array.isArray`) previously materialized a FRESH closure struct on
 * every read, so `Array.isArray === Array.isArray` was `false` — two distinct
 * instances. ES requires a builtin method to be a single function object, so
 * this is a genuine correctness bug. The fix routes every reified-builtin value
 * read through a MODULE-LEVEL SINGLETON global (one per (builtin, member)),
 * lazily materialized once — so all reads yield the same ref.
 *
 * Verified beyond "does it compile": the swap-wrong-builtin check
 * (`Array.isArray === Object.keys` MUST stay `false`) guards against the
 * "coincidental wrongness" trap where a placeholder value passes an identity
 * assertion by cancelling against an equally-wrong comparison target
 * (memory `project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous`).
 */

async function runStandalone(src: string): Promise<{ value: number; hostImports: string[] }> {
  const full = `export function test(): number { ${src} }`;
  const r = await compile(full, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const hostImports = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => l.startsWith("env::"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const value = (instance.exports as { test: () => number }).test();
  return { value, hostImports };
}

describe("#2963 — reified builtin static-method value identity (standalone)", () => {
  it("Array.isArray === Array.isArray (was false — fresh struct per read)", async () => {
    const { value } = await runStandalone(`const a = Array.isArray, b = Array.isArray; return a === b ? 1 : 0;`);
    expect(value).toBe(1);
  });

  it("Object.keys === Object.keys", async () => {
    const { value } = await runStandalone(`const a = Object.keys, b = Object.keys; return a === b ? 1 : 0;`);
    expect(value).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor === Object.getOwnPropertyDescriptor", async () => {
    const { value } = await runStandalone(
      `const a = Object.getOwnPropertyDescriptor, b = Object.getOwnPropertyDescriptor; return a === b ? 1 : 0;`,
    );
    expect(value).toBe(1);
  });

  // The coincidental-wrongness guard: distinct builtins keep distinct identity.
  it("Array.isArray !== Object.keys (swap-wrong-builtin guard)", async () => {
    const { value } = await runStandalone(`return ((Array.isArray as unknown) === (Object.keys as unknown)) ? 1 : 0;`);
    expect(value).toBe(0);
  });

  // Identity must not break the call path: a reified value is still callable.
  it("reified Array.isArray remains callable and correct", async () => {
    const arr = await runStandalone(`const f = Array.isArray; return f([1, 2]) ? 1 : 0;`);
    expect(arr.value).toBe(1);
    const nonArr = await runStandalone(`const f = Array.isArray; return f(5 as unknown as never[]) ? 1 : 0;`);
    expect(nonArr.value).toBe(0);
  });

  it("identity reification adds no host import", async () => {
    const { hostImports } = await runStandalone(`const a = Array.isArray, b = Array.isArray; return a === b ? 1 : 0;`);
    // No __get_builtin / __box_number / etc. introduced by the singleton read.
    expect(hostImports.filter((h) => h.includes("__get_builtin"))).toEqual([]);
  });
});
