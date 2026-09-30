// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6772 — ES2015 standalone class residue. One probe per mechanism step, each
// the minimal shape of its test262 row(s). Every "RED on base" case records the
// value `origin/main` @ 08e61b2644 answered and asserts node's answer; every
// guard case asserts an answer base already gave, to hold order preservation.
//
// Probes run standalone (`imports: []`) with the top-level code deferred into
// `__module_init`, then read the module's `__r` accumulator.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runProbe(body: string): Promise<unknown> {
  const source = `var __r = 0;\n${body}\nexport function readResult() { return __r; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports ?? [], "#6772 probes must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as { __module_init?: () => void; readResult: () => unknown };
  exports.__module_init?.();
  return exports.readResult();
}

describe("#6772 S1a — super(...) publishes extras to a parent that reads `arguments`", () => {
  it("RED on base (0): the super(1, 2) site into a zero-formal parent (node 2121)", async () => {
    expect(
      await runProbe(`
        var seen = 0;
        class Base { constructor(){ seen = seen * 100 + arguments.length * 10 + (arguments[0] === 1 ? 1 : 0); } }
        class Sub extends Base { constructor(){ super(1, 2); } }
        class Sub2 extends Base { constructor(x, y){ super(1, 2); } }
        new Sub(3, 4);
        new Sub2(3, 4);
        __r = seen;
      `),
    ).toBe(2121);
  });

  it("guard (base 21): the direct new Base(1, 2) site is unchanged", async () => {
    expect(
      await runProbe(`
        var seen = 0;
        class Base { constructor(){ seen = arguments.length * 10 + (arguments[0] === 1 ? 1 : 0); } }
        class Sub extends Base { constructor(){ super(1, 2); } }
        new Base(1, 2);
        __r = seen;
      `),
    ).toBe(21);
  });
});

describe("#6772 S1b — derived-constructor GetThisBinding / BindThisValue", () => {
  it("RED on base (0): `this.x = v` before super() throws ReferenceError (node 3)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){} }
        class D extends Base {
          constructor(){
            var e;
            try { this.x = 3; } catch (err) { e = err; }
            super();
            __r = (e instanceof ReferenceError) ? 1 : 0;
            __r += (this.x === undefined) ? 2 : 0;
          }
        }
        new D();
      `),
    ).toBe(3);
  });

  it("RED on base (0): `this` / super.x / super.m() / super() inside and before super(...) (node 63)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(a){} }
        var r = 0;
        try { class C extends Base { constructor(){ super(this.x); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 1 : 0; }
        try { class C extends Base { constructor(){ super(this); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 2 : 0; }
        try { class C extends Base { constructor(){ super(super()); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 4 : 0; }
        try { class C extends Base { constructor(){ super.method(); super(this); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 8 : 0; }
        try { class C extends Base { constructor(){ super(super.method()); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 16 : 0; }
        try { class C extends Base { constructor(){ super(1, 2, Object.getPrototypeOf(this)); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 32 : 0; }
        __r = r;
      `),
    ).toBe(63);
  });

  it("RED on base (14): a second super() runs the parent, then throws; `this` unchanged (node 15)", async () => {
    expect(
      await runProbe(`
        var baseCalled = 0; var fCalled = 0;
        class Base { constructor(){ baseCalled++; } }
        function f(){ fCalled++; return 3; }
        class S extends Base {
          constructor(){
            super();
            var obj = this; var exn = null; baseCalled = 0;
            try { super(f()); } catch (e) { exn = e; }
            __r = (exn instanceof ReferenceError ? 1 : 0) + (fCalled === 1 ? 2 : 0) + (baseCalled === 1 ? 4 : 0) + (this === obj ? 8 : 0);
          }
        }
        new S();
      `),
    ).toBe(15);
  });

  it("RED on base (133): the nested shapes super(super(), f()) and super(f(), super()) (node 3333)", async () => {
    // Each digit: ReferenceError (1) + fCalled matches node (1) + baseCalled === 1 (1),
    // per shape; the inner super() runs Base and throws at its own completion.
    expect(
      await runProbe(`
        var baseCalled = 0; var fCalled = 0;
        class Base { constructor(){ baseCalled++; } }
        function f(){ fCalled++; return 3; }
        class S extends Base {
          constructor(){
            super();
            var exn = null; baseCalled = 0; fCalled = 0;
            try { super(super(), f()); } catch (e) { exn = e; }
            var a = (exn instanceof ReferenceError ? 1 : 0) + (fCalled === 0 ? 1 : 0) + (baseCalled === 1 ? 1 : 0);
            exn = null; baseCalled = 0; fCalled = 0;
            try { super(f(), super()); } catch (e) { exn = e; }
            var b = (exn instanceof ReferenceError ? 1 : 0) + (fCalled === 1 ? 1 : 0) + (baseCalled === 1 ? 1 : 0);
            __r = a * 1000 + b * 100 + 33;
          }
        }
        new S();
      `),
    ).toBe(3333);
  });

  it("RED on base (880): compound / update / element writes and a bare read of `this` before super() (node 1023)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){ this.b = 1; } }
        var r = 0;
        try { class C extends Base { constructor(){ this.x += 1; super(); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 1 : 0; }
        try { class C extends Base { constructor(){ this.x++; super(); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 2 : 0; }
        try { class C extends Base { constructor(){ var k = 'y'; this[k] = 3; super(); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 4 : 0; }
        try { class C extends Base { constructor(){ var t = this; super(); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 8 : 0; }
        class A1 extends Base { constructor(){ var f = () => this.b; super(); this.v = f(); } }
        r += (new A1().v === 1) ? 16 : 0;
        class F1 extends Base { x = 5; constructor(){ super(); this.y = this.x + this.b; } }
        r += (new F1().y === 6) ? 32 : 0;
        try { class L extends Base { constructor(){ for (var i = 0; i < 2; i++) { if (i === 1) { this.q = 1; break; } super(); } } } var l = new L(); r += (l.q === 1) ? 64 : 0; } catch (e) { r += 0; }
        try { class L2 extends Base { constructor(){ for (var i = 0; i < 2; i++) super(); } } new L2(); } catch (e) { r += (e instanceof ReferenceError) ? 128 : 0; }
        class Br extends Base { constructor(a){ if (a) super(); else super(); this.z = 2; } }
        r += (new Br(1).z === 2 && new Br(0).z === 2) ? 256 : 0;
        class I extends Base {}
        r += (new I().b === 1) ? 512 : 0;
        __r = r;
      `),
    ).toBe(1023);
  });

  it("guard: a plain derived class with one straight-line super() allocates no flag", async () => {
    const result = await compile(
      `class Base { constructor(){ this.b = 1; } }
       class D extends Base { constructor(){ super(); this.c = this.b + 1; } }
       export function probe() { return new D().c; }`,
      { target: "standalone", fileName: "guard.js", allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect(Buffer.from(result.binary).includes(Buffer.from("__js2_super_done"))).toBe(false);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { probe: () => number }).probe()).toBe(2);
  });
});
