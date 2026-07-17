// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3202 / #3335 Part 1 — `%TypedArray%.prototype.set(source, offset)` must throw
// a *catchable* RangeError when the copy is out of bounds, NOT fall through to an
// unguarded `array.copy` / element-wise store that emits an uncatchable Wasm
// `oob` trap.
//
// Per ECMA-262 §23.2.3.24, `set` performs the bounds check as an observable
// step: if `targetOffset < 0` or `srcLength + targetOffset > targetLength`, it
// throws a **RangeError**. The prior `compileTypedArraySet` (array-methods.ts)
// omitted the bounds check entirely, so an OOB offset trapped `oob` — an
// uncatchable abort that escapes `try`/`catch` and poisons the whole test file
// (#3179). That is precisely the failure the #3189 oob-trap ratchet exists to
// prevent (it fired 45→51 / 58→62 on the BigInt/set family — #3335 / #3202).
//
// The fix extracts the receiver length (vec field 0) and gates the copy on
// `offset < 0 || offset + srcLen > dstLen`, throwing a real RangeError instance
// (`buildThrowJsErrorInstrs`) in both lanes. Dual-mode: standalone emits the
// in-module `__new_RangeError` constructor, so no unsatisfiable `env::*` import
// is requested — verified by instantiating the standalone module against `{}`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runHost(src: string): Promise<Record<string, () => unknown>> {
  const r = await compile(src);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
  return instance.exports as Record<string, () => unknown>;
}

async function standaloneProbe(src: string): Promise<{ envImports: string[]; result: unknown }> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "standalone module failed WebAssembly.validate").toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  const envImports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const result = (instance.exports as { test: () => unknown }).test();
  return { envImports, result };
}

describe("#3202 — TypedArray.prototype.set OOB throws a catchable RangeError", () => {
  it("a valid in-bounds set still copies correctly", async () => {
    const ex = await runHost(
      `export function test(): boolean {
         const a = new Uint8Array(5);
         a.set([1, 2, 3], 1);
         return a[0] === 0 && a[1] === 1 && a[2] === 2 && a[3] === 3 && a[4] === 0;
       }`,
    );
    expect(ex.test()).toBe(1);
  });

  it("an exact-fit set at offset 0 does not throw", async () => {
    const ex = await runHost(
      `export function test(): boolean {
         const a = new Uint8Array(3);
         a.set([9, 9, 9], 0);
         return a[0] === 9 && a[1] === 9 && a[2] === 9;
       }`,
    );
    expect(ex.test()).toBe(1);
  });

  it("offset + srcLength > targetLength throws a *catchable* RangeError", async () => {
    const ex = await runHost(
      `export function test(): boolean {
         const a = new Uint8Array(3);
         try {
           a.set([1, 2, 3], 5);
           return false;
         } catch (e) {
           return e instanceof RangeError;
         }
       }`,
    );
    expect(ex.test()).toBe(1);
  });

  it("a source that overruns the end by one throws a catchable RangeError", async () => {
    const ex = await runHost(
      `export function test(): boolean {
         const a = new Uint8Array(3);
         try {
           a.set([1, 2, 3], 1); // 3 + 1 = 4 > 3
           return false;
         } catch (e) {
           return e instanceof RangeError;
         }
       }`,
    );
    expect(ex.test()).toBe(1);
  });

  it("a negative offset throws a catchable RangeError", async () => {
    const ex = await runHost(
      `export function test(): boolean {
         const a = new Uint8Array(3);
         try {
           a.set([1], -1);
           return false;
         } catch (e) {
           return e instanceof RangeError;
         }
       }`,
    );
    expect(ex.test()).toBe(1);
  });

  it("cross-type set (Float64Array from int literals) respects bounds", async () => {
    const ex = await runHost(
      `export function test(): boolean {
         const a = new Float64Array(2);
         try {
           a.set([1, 2, 3], 0); // 3 > 2
           return false;
         } catch (e) {
           return e instanceof RangeError;
         }
       }`,
    );
    expect(ex.test()).toBe(1);
  });

  it("standalone: OOB set throws a catchable RangeError with no env leak", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const a = new Uint8Array(3);
         try {
           a.set([1, 2, 3], 5);
           return false;
         } catch (e) {
           return e instanceof RangeError;
         }
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("standalone: a valid set is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const a = new Uint8Array(5);
         a.set([4, 5, 6], 2);
         return a[2] === 4 && a[3] === 5 && a[4] === 6;
       }`,
    );
    expect(envImports.length).toBe(0);
    expect(result).toBe(1);
  });
});
