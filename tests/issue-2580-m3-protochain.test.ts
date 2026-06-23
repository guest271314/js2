// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2580 M3 Stage A — standalone `[[Prototype]]`-link for an INLINE-LITERAL proto
// passed to `Object.create(proto)` / `Object.setPrototypeOf(obj, proto)`.
//
// Root cause: the native `__object_create` / `__object_setPrototypeOf` helpers
// write the link field `$Object.$proto` only when the proto value
// `ref.test $Object` succeeds (a non-`$Object` externref coerces to null, by
// design). `compileObjectLiteral` lowers an INLINE literal whose TS contextual
// type is a CONCRETE object type to a CLOSED-shape struct (`struct.new <typeIdx>`),
// which fails `ref.test $Object` — so `Object.create({foo:7}).foo` and
// `Object.setPrototypeOf(o,{foo:7}); o.foo` silently dropped the proto link and
// the chain walk read a null `$proto` → property absent → 0. A proto passed via a
// `const p:any = {foo:7}` *named variable* already worked because the `any`
// annotation diverts that literal to the open-`$Object` builder.
//
// Stage A builds the inline-literal proto as a native `$Object` (the merged #2076
// `compileObjectAssignArg` precedent), so `ref.test $Object` succeeds and the link
// is recorded. The standalone `$proto` walk in `__extern_get`/`__extern_get_idx`
// already resolves inherited NAMED and INDEXED reads once the link is populated.
//
// SCOPE / known-orthogonal: this slice fixes the proto LINK. Reading TWO inherited
// `any`-typed props in a single `+` expression (`c.a + c.b`) returns 0 on current
// main REGARDLESS of inheritance — a pre-existing `any + any` arithmetic-add bug
// (the #2580 M1/core uniform-externref consumer issue), NOT this slice. The tests
// below assert single-read access (store-to-local then add where a sum is needed),
// the shapes Stage A actually fixes. Host/GC mode still drops the proto (separate,
// larger `_objProto`-WeakMap + setPrototypeOf-stub follow-on, tracked) — these
// tests are standalone-only.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2580 M3 Stage A — inline-literal proto link (standalone)", () => {
  it("Object.create({foo:7}).foo resolves through the proto chain (was 0)", async () => {
    expect(
      await runStandalone(`export function test():number{ const c:any=Object.create({foo:7}); return c.foo; }`),
    ).toBe(7);
  });

  it("Object.create({5:99})[5] indexed inherited read (was 0)", async () => {
    expect(
      await runStandalone(`export function test():number{ const c:any=Object.create({5:99}); return c[5]; }`),
    ).toBe(99);
  });

  it("Object.setPrototypeOf(o,{foo:7}); o.foo resolves (was 0)", async () => {
    expect(
      await runStandalone(
        `export function test():number{ const o:any={}; Object.setPrototypeOf(o,{foo:7}); return o.foo; }`,
      ),
    ).toBe(7);
  });

  it("multi-key inline proto: each inherited read resolves (single-read)", async () => {
    expect(
      await runStandalone(
        `export function test():number{ const c:any=Object.create({a:10,b:20}); const x:number=c.a; const y:number=c.b; return x+y; }`,
      ),
    ).toBe(30);
  });

  it("own property shadows the inline-literal inherited one", async () => {
    expect(
      await runStandalone(
        `export function test():number{ const c:any=Object.create({foo:7}); c.foo=9; return c.foo; }`,
      ),
    ).toBe(9);
  });

  it("Object.create({foo:7}, descriptors): inherited foo + own descriptor (single-read)", async () => {
    expect(
      await runStandalone(
        `export function test():number{ const c:any=Object.create({foo:7},{bar:{value:3,enumerable:true}}); const a:number=c.foo; const b:number=c.bar; return a+b; }`,
      ),
    ).toBe(10);
  });

  // Regression guards: the existing working paths must stay byte-correct.
  it("named-var proto still works (existing path, unchanged)", async () => {
    expect(
      await runStandalone(
        `export function test():number{ const p:any={foo:7}; const c:any=Object.create(p); return c.foo; }`,
      ),
    ).toBe(7);
  });

  it("Object.create(null): absent property reads undefined", async () => {
    expect(
      await runStandalone(
        `export function test():number{ const c:any=Object.create(null); return (c.foo===undefined)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("Object.create(Foo.prototype) class fast path unaffected", async () => {
    expect(
      await runStandalone(
        `class Foo{x:number=5;} export function test():number{ const c:any=Object.create(Foo.prototype); return (c.x===0)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("Object.setPrototypeOf(o,null) clears proto, own props intact", async () => {
    expect(
      await runStandalone(
        `export function test():number{ const o:any={a:1}; Object.setPrototypeOf(o,null); return o.a; }`,
      ),
    ).toBe(1);
  });

  it("array .length stays numeric (hot path byte-identical)", async () => {
    expect(await runStandalone(`export function test():number{ const a=[1,2,3]; return a.length; }`)).toBe(3);
  });
});
