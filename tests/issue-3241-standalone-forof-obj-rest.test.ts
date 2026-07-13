// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3241 — native object-rest CopyDataProperties (ES §14.7.4) for the
 * FOR-OF / FOR-AWAIT loop-var rest binding in standalone / WASI.
 *
 * #3223 made the DECL (`const {a,...rest} = o`) and function-PARAM rest paths
 * host-free (routing to the DEFINED native `__extern_rest_object` with an
 * exclusion-OBJECT arg). The for-of/for-await loop-var rest site
 * (`for (const {a,...rest} of arr)`) still emitted the `env.__extern_rest_object`
 * host import — which both LEAKS an env:: import (breaking zero-import
 * instantiation) AND, once the native func was registered by another rest site
 * in the same module, was silently miscompiled (the host site passed a
 * comma-joined excluded STRING, not the exclusion OBJECT the native helper
 * expects, so `__extern_has` reported "absent" and NO key was excluded).
 *
 * These tests instantiate with an EMPTY import object (`{}`) to prove genuine
 * host-free enumeration, and assert exclusion + own-enumerable-copy semantics
 * (including getter [[Get]] invocation and non-enumerable skipping).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // No `env::__extern_rest_object` (nor any env:: import) should be emitted.
  expect(/import "env" "__extern_rest_object"/.test(r.wat ?? ""), "leaked env::__extern_rest_object").toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f(): number }).f();
}

describe("#3241 — standalone for-of object-rest", () => {
  it("rest keeps the remaining own keys and excludes the named binding", async () => {
    // {a,...rest} of {a:1,x:2,y:3} → rest keys = [x,y] → length 2
    expect(
      await runStandalone(`export function f(): number {
        let n = 0;
        for (const { a, ...rest } of [{ a: 1, x: 2, y: 3 }]) { n = Object.keys(rest).length; }
        return n; }`),
    ).toBe(2);
  });

  it("rest carries the correct VALUES and drops the excluded key", async () => {
    // rest.x + rest.y = 2 + 3 = 5, and rest.a is undefined (excluded)
    expect(
      await runStandalone(`export function f(): number {
        let s = 0;
        for (const { a, ...rest } of [{ a: 1, x: 2, y: 3 }]) {
          s = (rest.x || 0) + (rest.y || 0) + (rest.a ? 100 : 0);
        }
        return s; }`),
    ).toBe(5);
  });

  it("multi-binding rest excludes every named binding", async () => {
    // {a,b,...rest} of {x:1,y:2,a:5,b:3} → rest keys = [x,y] → length 2
    expect(
      await runStandalone(`export function f(): number {
        let n = 0;
        for (const { a, b, ...rest } of [{ x: 1, y: 2, a: 5, b: 3 }]) { n = Object.keys(rest).length; }
        return n; }`),
    ).toBe(2);
  });

  it("rest invokes own getters ([[Get]]) when copying values", async () => {
    // rest.y reads the getter's returned 42; rest.x = 1 → 43
    expect(
      await runStandalone(`export function f(): number {
        let n = 0;
        const src = { x: 1, get y() { return 42; }, a: 9 };
        for (const { a, ...rest } of [src]) { n = (rest.x || 0) + (rest.y || 0); }
        return n; }`),
    ).toBe(43);
  });

  it("rest skips non-enumerable own properties", async () => {
    // "hidden" is defined non-enumerable → not copied; rest.x = 2 → 2
    expect(
      await runStandalone(`export function f(): number {
        const o: any = { a: 1, x: 2 };
        Object.defineProperty(o, "hidden", { value: 99, enumerable: false });
        let n = 0;
        for (const { a, ...rest } of [o]) { n = (rest.x || 0) + (rest.hidden ? 100 : 0); }
        return n; }`),
    ).toBe(2);
  });

  it("wasi target enumerates the for-of rest the same way", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
          let n = 0;
          for (const { a, ...rest } of [{ a: 1, x: 2, y: 3 }]) { n = Object.keys(rest).length; }
          return n; }`,
        "wasi",
      ),
    ).toBe(2);
  });
});
