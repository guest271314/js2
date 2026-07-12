// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3181 — standalone Number.prototype residual clusters (from #3175).
//
// Cluster C — method `.length` fold. `Number.prototype.<m>.length` was folding
// to NaN because the shared `PROTO_METHOD_LENGTH` arity table (array-object-
// proto.ts) was a plain object literal: a lookup of an `Object.prototype`-
// inherited method name (`toString`/`valueOf`/`toLocaleString`) returned the
// INHERITED FUNCTION rather than `undefined`, slipping past the `?? 1` fallback
// and emitting the `Function` as an f64 → NaN. The table is now null-prototyped
// with explicit arities for those three names (all 0 cross-family; Number's
// `toString(radix)` overridden to 1 in the Number glue). The same hazard in
// `BUILTIN_STATIC_METHOD_ARITY` (builtin-fn-meta.ts) is fixed via a deep
// null-proto wrapper.
//
// Spec: ECMA-262 §21.1.3 (Number.prototype method arities).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3181 Cluster C — standalone builtin-proto method .length fold", () => {
  it("Number.prototype.toString.length === 1 (radix arg)", async () => {
    expect(await runStandalone(`export function test(): number { return Number.prototype.toString.length; }`)).toBe(1);
  });

  it("Number.prototype.valueOf.length === 0", async () => {
    expect(await runStandalone(`export function test(): number { return Number.prototype.valueOf.length; }`)).toBe(0);
  });

  it("Number.prototype.toLocaleString.length === 0", async () => {
    expect(
      await runStandalone(`export function test(): number { return Number.prototype.toLocaleString.length; }`),
    ).toBe(0);
  });

  it("Number.prototype.toFixed.length stays 1", async () => {
    expect(await runStandalone(`export function test(): number { return Number.prototype.toFixed.length; }`)).toBe(1);
  });

  // Cross-family regression guard: the shared table's null-proto fix must give
  // every OTHER family's `toString`/`valueOf` the spec arity 0 (was NaN before).
  it("Array.prototype.toString.length === 0", async () => {
    expect(await runStandalone(`export function test(): number { return Array.prototype.toString.length; }`)).toBe(0);
  });

  it("String.prototype.toString.length === 0", async () => {
    expect(await runStandalone(`export function test(): number { return String.prototype.toString.length; }`)).toBe(0);
  });

  it("Object.prototype.toString.length === 0", async () => {
    expect(await runStandalone(`export function test(): number { return Object.prototype.toString.length; }`)).toBe(0);
  });

  it("Object.prototype.valueOf.length === 0", async () => {
    expect(await runStandalone(`export function test(): number { return Object.prototype.valueOf.length; }`)).toBe(0);
  });

  // The `.name` fold (already working pre-#3181) must keep reporting the member
  // name unchanged by the null-proto change.
  it("Number.prototype.toString.name === 'toString'", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return Number.prototype.toString.name === "toString" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Number.prototype.valueOf.name === 'valueOf'", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return Number.prototype.valueOf.name === "valueOf" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
