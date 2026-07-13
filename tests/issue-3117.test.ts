// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3117 — $Object dot-member-set stored-closure invocation (standalone).
 *
 * `const o: any = {}; o.f = function () { return 7; }; o.f()` returned
 * `undefined` on current main: the `{}` literal is pre-shaped into a closed
 * struct whose externref FIELD `f` receives the closure via `struct.set`, but
 * the any-receiver method dispatcher `__call_m_f_0` only type-switched over
 * structs having a `<Struct>_f` METHOD func — no arm for a field-stored
 * closure. So the call fell to the open-`$Object` bottom arm and returned
 * undefined. The computed-key twin (`o["f"] = fn`) worked (a genuine
 * `$Object` store).
 *
 * Fix (`collectFieldEntries`, closed-method-dispatch.ts): every closed struct
 * with an externref field `<name>` (and no `<Struct>_<name>` method — methods
 * win) gets a dispatcher arm that reads the field and invokes it via
 * `__apply_closure(fn, recv, argvec)`. Both the fixed-arity and vararg fills.
 *
 * Every case compiles standalone and must instantiate with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3117 — dot-member-set stored closure is callable (standalone)", () => {
  it("dot-set function expression: o.f = function(){7}; o.f()", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.f = function () { return 7; };
        return o.f();
      }`),
    ).toBe(7);
  });

  it("dot-set arrow: o.f = () => 7; o.f()", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.f = () => 7;
        return o.f();
      }`),
    ).toBe(7);
  });

  it("dot-set named function expression: o.f = function nf(){7}; o.f()", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.f = function nf () { return 7; };
        return o.f();
      }`),
    ).toBe(7);
  });

  it("dot-set arrow with arg: o.g = (x)=>x+1; o.g(4)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.g = (x: number) => x + 1;
        return o.g(4);
      }`),
    ).toBe(5);
  });

  it("dot-set function expression with arg: o.g = function(x){x+1}; o.g(4)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.g = function (x: number) { return x + 1; };
        return o.g(4);
      }`),
    ).toBe(5);
  });

  it("stored closure captures its lexical scope", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const base = 40;
        const o: any = {};
        o.add = (x: number) => base + x;
        return o.add(2);
      }`),
    ).toBe(42);
  });

  it("two dot-set closures on the same object are independently callable", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.a = () => 3;
        o.b = (x: number) => x * 2;
        return o.a() + o.b(4);
      }`),
    ).toBe(11);
  });

  it("regression: computed-key store still callable (o['f'] = fn)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o["f"] = function () { return 7; };
        return o.f();
      }`),
    ).toBe(7);
  });

  it("regression: an object-literal METHOD still wins over a field arm", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { f() { return 9; } };
        return o.f();
      }`),
    ).toBe(9);
  });
});
