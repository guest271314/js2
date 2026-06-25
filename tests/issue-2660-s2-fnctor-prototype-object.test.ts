// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2660 S2 — per-fnctor prototype `$Object` (standalone).
//
// A user function constructor `F` is lowered to a closure trampoline struct, NOT
// an `$Object`, so `F.prototype` read/write went through `__extern_get` /
// `__extern_set` on the closure struct (which `ref.test $Object` misses → the
// write is dropped, the read returns null). `Object.create(F.prototype).foo`
// therefore returned 0. S2 synthesizes a per-fnctor prototype `$Object` held in a
// `mut externref` module global so `F.prototype` is a readable/writable `$Object`
// — the readable `$Object` that #2660 S3 seeds `new F()` instances' `$proto` from.
//
// SCOPE (RECONSTRUCT-GATE): S2 only materializes the prototype `$Object` for a
// constructor S3 will reconstruct — one with a `reconstruct`-classified `new F()`
// site (S1 escape-gate, clause A∧B: dynamically consumed, no typed own-field).
// A `keep-typed` / `keep-static` / never-`new`'d function keeps its existing
// prototype behaviour untouched (an unscoped interception clobbered working paths
// — species `Ctor.prototype` identity + `Test262Error.prototype.toString` — and
// ejected the standalone floor −40). So every S2 case below constructs `Con` and
// uses the instance dynamically (`child.zzz` — a non-own-field read), which marks
// `Con` reconstruct and arms S2. Gated on standalone; host/GC is byte-identical.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

// Reconstruct-arming prelude: `new Con()` + a dynamic member read on the instance
// marks `Con` as a `reconstruct` fnctor so S2's per-fnctor prototype materializes.
const ARM = "const __child:any=new Con(); const __dyn:any=__child.zzz;";

describe("#2660 S2 — per-fnctor prototype $Object (standalone)", () => {
  it("whole-reassign: Con.prototype = {foo:7}; Object.create(Con.prototype).foo (was 0)", async () => {
    expect(
      await runStandalone(
        `function Con(){}; (Con as any).prototype = {foo:7}; export function test():number{ ${ARM} const c:any=Object.create((Con as any).prototype); return c.foo; }`,
      ),
    ).toBe(7);
  });

  it("bare-identifier whole-reassign (the real test262 cluster shape, no cast)", async () => {
    expect(
      await runStandalone(
        `function Con(){}; Con.prototype = {foo:7}; export function test():number{ ${ARM} const c:any=Object.create(Con.prototype); return c.foo; }`,
      ),
    ).toBe(7);
  });

  it("per-prop: Con.prototype.foo = 7; Object.create(Con.prototype).foo (was 0)", async () => {
    expect(
      await runStandalone(
        `function Con(){}; (Con as any).prototype.foo = 7; export function test():number{ ${ARM} const c:any=Object.create((Con as any).prototype); return c.foo; }`,
      ),
    ).toBe(7);
  });

  it("per-prop accumulates multiple keys across statements", async () => {
    expect(
      await runStandalone(
        `function Con(){}; (Con as any).prototype.a = 1; (Con as any).prototype.b = 2; export function test():number{ ${ARM} const c:any=Object.create((Con as any).prototype); const x:number=c.a; const y:number=c.b; return x+y; }`,
      ),
    ).toBe(3);
  });

  it("indexed key in the prototype literal resolves through the proto walk", async () => {
    expect(
      await runStandalone(
        `function Con(){}; (Con as any).prototype = {5:99}; export function test():number{ ${ARM} const c:any=Object.create((Con as any).prototype); return c[5]; }`,
      ),
    ).toBe(99);
  });

  it("var Con = function(){} (function-expression fnctor) prototype resolves", async () => {
    expect(
      await runStandalone(
        `const Con = function(){}; (Con as any).prototype = {foo:7}; export function test():number{ ${ARM} const c:any=Object.create((Con as any).prototype); return c.foo; }`,
      ),
    ).toBe(7);
  });

  it("own property on the created object shadows the inherited prototype one", async () => {
    expect(
      await runStandalone(
        `function Con(){}; (Con as any).prototype = {foo:7}; export function test():number{ ${ARM} const c:any=Object.create((Con as any).prototype); c.foo=9; return c.foo; }`,
      ),
    ).toBe(9);
  });

  // ── RECONSTRUCT-GATE guard: a non-reconstruct fnctor is NOT intercepted ──────
  it("non-reconstruct fnctor (no `new`) keeps existing prototype behaviour (S2 off)", async () => {
    // No `new Con()` ⇒ Con is not in the reconstruct set ⇒ S2 declines ⇒ the
    // legacy closure-slot path runs (returns 0). The point is that S2 does NOT
    // fire here — it must not clobber the species-constructor / harness paths.
    expect(
      await runStandalone(
        `function Con(){}; (Con as any).prototype = {foo:7}; export function test():number{ const c:any=Object.create((Con as any).prototype); return (c.foo===undefined||c.foo===0)?1:0; }`,
      ),
    ).toBe(1);
  });

  // ── Regression guards: existing working paths stay byte-correct ─────────────
  it("class fast path Object.create(Foo.prototype) unaffected", async () => {
    expect(
      await runStandalone(
        `class Foo{x:number=5;} export function test():number{ const c:any=Object.create(Foo.prototype); return (c.x===0)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("named-variable proto Object.create(p) unaffected", async () => {
    expect(
      await runStandalone(
        `export function test():number{ const p:any={foo:7}; const c:any=Object.create(p); return c.foo; }`,
      ),
    ).toBe(7);
  });

  it("typed array .length hot path unaffected", async () => {
    expect(await runStandalone(`export function test():number{ const a:any=[1,2,3]; return a.length; }`)).toBe(3);
  });
});
