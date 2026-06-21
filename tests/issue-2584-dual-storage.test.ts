// #2584 — dot-assign vs bracket/`in`/keys-read dual-storage (standalone).
//
// An `any`-typed object written via DOT-access but read via BRACKET / `in` /
// Object.keys / getOwnPropertyDescriptor returned the wrong value, because the
// empty-object widening pre-pass widened the var to a closed WasmGC struct (the
// dot-write lands in `struct.set`), while the `$Object`-hash-runtime consumers
// (bracket-read, `in`, keys, GOPD, entries, values, for-in) only see the native
// `$Object` open hash — never a widened struct:
//
//   const o: any = {};
//   o.a = 7;
//   o["a"];        // → 0     (expected 7)   ❌ before
//   "a" in o;      // → false (expected true) ❌ before
//
// Fix (poison widening): when a candidate empty-init var is ALSO the subject of
// any `$Object`-hash-only operation, it is added to `objectHashConsumerVars` and
// struct-widening is suppressed — the var stays a `__new_plain_object` / $Object,
// dot-writes route through `__extern_set`, and every access form reads the same
// hash. Mirrors the proven `dynamicDescriptorWidenVars` poison (#2372).
// Standalone-gated; host keeps the struct fast path via the live-mirror Proxy.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `source` with `--target standalone`, run `test()`, return its value. */
async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const imp = (result as unknown as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imp);
  (imp as unknown as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2584 dot-vs-bracket dual storage (standalone)", () => {
  it("dot-write → bracket-read reads back the value", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        return o["a"];
      }`),
    ).toBe(7);
  });

  it("dot-write → `in` sees the property", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        return ("a" in o) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("dot-write → Object.keys enumerates the properties", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        o.b = 8;
        const ks = Object.keys(o);
        return ks.length;
      }`),
    ).toBe(2);
  });

  it("dot-write → getOwnPropertyDescriptor reads value", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        const d = Object.getOwnPropertyDescriptor(o, "a");
        return d.value;
      }`),
    ).toBe(7);
  });

  it("dot-write → Object.values reads values", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        o.b = 8;
        const v = Object.values(o);
        return (v[0] as number) + (v[1] as number);
      }`),
    ).toBe(15);
  });

  it("dot-write → for-in iterates the properties", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        o.b = 8;
        let c = 0;
        for (const k in o) { c++; }
        return c;
      }`),
    ).toBe(2);
  });

  it("dot-write → Object.assign source copies the property", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        const t2: any = {};
        Object.assign(t2, o);
        return t2["a"];
      }`),
    ).toBe(7);
  });

  it("mixed dot + bracket writes, mixed reads", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        o["b"] = 8;
        return (o["a"] as number) + (o.b as number);
      }`),
    ).toBe(15);
  });

  it("numeric bracket read on a dot-written var poisons → absent index is undefined", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        return (o[0] === undefined) ? 7 : 0;
      }`),
    ).toBe(7);
  });

  // ── Regression guards: the struct fast path must survive for non-poisoned vars.
  it("regression: dot-only var keeps the struct fast path (correct value)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = 7;
        o.b = 8;
        o.c = 9;
        return o.a + o.b + o.c;
      }`),
    ).toBe(24);
  });

  it("regression: typed struct var unaffected", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o = { a: 0 };
        o.a = 7;
        return o.a;
      }`),
    ).toBe(7);
  });

  it("regression: bracket-only var still works", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o["a"] = 7;
        return o["a"];
      }`),
    ).toBe(7);
  });
});
