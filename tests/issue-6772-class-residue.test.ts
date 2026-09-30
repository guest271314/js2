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

describe("#6772 S2 \u2014 constructor return-override channel", () => {
  it("RED on base (8): foreign-object override \u2014 base / inherited / derived / extends-null (node 63)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(a,b){ var o = new Object(); o.prp = a + b; return o; } }
        var b = new Base(1,2);
        var r = (b.prp === 3) ? 1 : 0;
        var obj = {};
        class Base3 { constructor(){ return obj; } }
        class Sub3 extends Base3 {}
        var s3 = new Sub3();
        r += (s3 === obj) ? 2 : 0;
        class B2 { constructor(){ this.prop = 1; } }
        class D2 extends B2 { constructor(){ super(); return {}; } }
        var o2 = new D2();
        r += (typeof o2.prop === 'undefined') ? 4 : 0;
        r += (o2 instanceof D2) ? 0 : 8;
        var obj2;
        class Foo extends null { constructor(){ return obj2 = {}; } }
        var f = new Foo();
        r += (f === obj2) ? 16 : 0;
        r += (Object.getPrototypeOf(f) === Object.prototype) ? 32 : 0;
        __r = r;
      `),
    ).toBe(63);
  });

  it("RED on base (4608): this-access-restriction-2 distilled \u2014 override, derived `this`, second super() (node 8191)", async () => {
    expect(
      await runProbe(`
        var r = 0;
        class Base {
          constructor(a, b) {
            var o = new Object();
            o.prp = a + b;
            return o;
          }
        }
        class Subclass extends Base {
          constructor(a, b) {
            var exn;
            try { this.prp1 = 3; } catch (e) { exn = e; }
            r += (exn instanceof ReferenceError) ? 1 : 0;
            super(a, b);
            r += (this.prp === a + b) ? 2 : 0;
            r += (this.prp1 === undefined) ? 4 : 0;
            r += (this.hasOwnProperty("prp1") === false) ? 8 : 0;
            return this;
          }
        }
        var b = new Base(1, 2);
        r += (b.prp === 3) ? 16 : 0;
        var s = new Subclass(2, -1);
        r += (s.prp === 1) ? 32 : 0;
        r += (s.prp1 === undefined) ? 64 : 0;
        r += (s.hasOwnProperty("prp1") === false) ? 128 : 0;
        class Subclass2 extends Base {
          constructor(x) {
            super(1, 2);
            if (x < 0) return;
            var called = false;
            function tmp() { called = true; return 3; }
            var exn = null;
            try { super(tmp(), 4); } catch (e) { exn = e; }
            r += (exn instanceof ReferenceError) ? 256 : 0;
            r += (called === true) ? 512 : 0;
          }
        }
        var s2 = new Subclass2(1);
        r += (s2.prp === 3) ? 1024 : 0;
        var s3 = new Subclass2(-1);
        r += (s3.prp === 3) ? 2048 : 0;
        class BadSubclass extends Base { constructor() {} }
        try { new BadSubclass(); } catch (e) { r += (e instanceof ReferenceError) ? 4096 : 0; }
        __r = r;
      `),
    ).toBe(8191);
  });

  it("RED on base (4): `typeof` / reads of a declared field off the override object (node 7)", async () => {
    expect(
      await runProbe(`
        class B2 { constructor(){ this.prop = 1; } }
        class D2 extends B2 { constructor(){ super(); return {}; } }
        var o2 = new D2();
        var r = 0;
        r += (typeof o2.prop === 'undefined') ? 1 : 0;
        var t = typeof o2.prop;
        r += (t === 'undefined') ? 2 : 0;
        r += (o2.prop === undefined) ? 4 : 0;
        __r = r;
      `),
    ).toBe(7);
  });

  it("RED on base (10): `return {}` is a plain object, not the class's own struct (node 7)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){ return {}; } }
        var r = 0;
        var b = new Base();
        r += (b instanceof Base) ? 0 : 1;
        r += (typeof b === "object") ? 2 : 0;
        var p = Object.getPrototypeOf(b);
        r += (p === Object.prototype) ? 4 : 0;
        r += (p === Base.prototype) ? 8 : 0;
        r += (p === null) ? 16 : 0;
        r += (p === undefined) ? 32 : 0;
        __r = r;
      `),
    ).toBe(7);
  });

  it("RED on base (7): getPrototypeOf / instanceof through a marked parent (node 31)", async () => {
    expect(
      await runProbe(`
        var flag = false;
        class Base { constructor(){ this.x = 1; if (flag) return {}; } m() { return 1; } }
        class Sub extends Base { constructor(){ super(); } }
        var r = 0;
        var b = new Base();
        r += (Object.getPrototypeOf(b) === Base.prototype) ? 1 : 0;
        var s = new Sub();
        r += (Object.getPrototypeOf(s) === Sub.prototype) ? 2 : 0;
        r += (s instanceof Base && s instanceof Sub) ? 4 : 0;
        flag = true;
        var s2 = new Sub();
        r += (Object.getPrototypeOf(s2) === Object.prototype) ? 8 : 0;
        r += (s2 instanceof Sub) ? 0 : 16;
        __r = r;
      `),
    ).toBe(31);
  });

  it("RED on base (63): a non-overriding instance keeps fields, methods, accessor, instanceof (node 255)", async () => {
    expect(
      await runProbe(`
        var flag = false;
        var other = { prp: 99 };
        class Base {
          constructor(a) { this.x = a; this.y = a + 1; if (flag) return other; }
          m() { return this.x * 10; }
          get g() { return this.y; }
          static s() { return 5; }
        }
        var r = 0;
        var b = new Base(3);
        r += (b.x === 3) ? 1 : 0;
        r += (b.m() === 30) ? 2 : 0;
        r += (b instanceof Base) ? 4 : 0;
        r += (b.g === 4) ? 8 : 0;
        b.x = 7;
        r += (b.m() === 70) ? 16 : 0;
        r += (Base.s() === 5) ? 32 : 0;
        flag = true;
        var c = new Base(1);
        r += (c === other && c.prp === 99) ? 64 : 0;
        r += (c instanceof Base) ? 0 : 128;
        __r = r;
      `),
    ).toBe(255);
  });

  it("RED on base (63): writes / compound / update / setter / private on a marked class (node 255)", async () => {
    expect(
      await runProbe(`
        var sink = null;
        class Base {
          #p = 5;
          constructor(a, o) { this.x = a; this._v = 0; if (o) return o; }
          get v() { return this._v; }
          set v(n) { this._v = n * 2; }
          peek() { return this.#p; }
          static has(o) { return #p in o; }
        }
        var r = 0;
        var b = new Base(3);
        b.x = 10;
        r += (b.x === 10) ? 1 : 0;
        b.x += 5;
        r += (b.x === 15) ? 2 : 0;
        b.x++;
        r += (b.x === 16) ? 4 : 0;
        b.v = 4;
        r += (b.v === 8 && b._v === 8) ? 8 : 0;
        r += (b.peek() === 5) ? 16 : 0;
        r += (Base.has(b)) ? 32 : 0;
        var o = {};
        var c = new Base(1, o);
        c.x = 9;
        r += (o.x === 9) ? 64 : 0;
        r += (Base.has(c)) ? 0 : 128;
        __r = r;
      `),
    ).toBe(255);
  });

  it("guard (base 63): a derived class of a marked base that does not override at runtime", async () => {
    expect(
      await runProbe(`
        var flag = false;
        class Base { constructor(v){ this.v = v; if (flag) return { v: -1, getV: function () { return -1; } }; } getV() { return this.v; } }
        class Sub extends Base {
          constructor(v){
            super(v);
            this.w = this.v * 2;
            this.z = this.getV() + 1;
            var f = () => this.w;
            this.q = f();
          }
          sum() { return this.v + this.w; }
        }
        var r = 0;
        var s = new Sub(3);
        r += (s.v === 3) ? 1 : 0;
        r += (s.w === 6) ? 2 : 0;
        r += (s.z === 4) ? 4 : 0;
        r += (s.q === 6) ? 8 : 0;
        r += (s.sum() === 9) ? 16 : 0;
        r += (s instanceof Sub && s instanceof Base) ? 32 : 0;
        __r = r;
      `),
    ).toBe(63);
  });

  it("guard (base 31): getPrototypeOf of a marked class OBJECT and its prototype keeps the class folds", async () => {
    expect(
      await runProbe(`
        var flag = false;
        class Base { constructor(){ this.x = 1; if (flag) return {}; } }
        class Sub extends Base { constructor(){ super(); } }
        var C = class { constructor(){ if (flag) return {}; } };
        var r = 0;
        r += (Object.getPrototypeOf(Base) === Function.prototype) ? 1 : 0;
        r += (Object.getPrototypeOf(Base.prototype) === Object.prototype) ? 2 : 0;
        r += (Object.getPrototypeOf(Sub.prototype) === Base.prototype) ? 4 : 0;
        r += (Object.getPrototypeOf(C) === Function.prototype) ? 8 : 0;
        r += (Object.getPrototypeOf(C.prototype) === Object.prototype) ? 16 : 0;
        __r = r;
      `),
    ).toBe(31);
  });

  it("RESIDUAL (base 0, node 31): a class METHOD read / call on the foreign override object resolves against the class", async () => {
    // Data members of a marked-class binding read dynamically; declared methods
    // keep the struct dispatch, so `c.m()` / `typeof d.m` miss the override
    // object's own shape (bits 2 and 16).
    expect(
      await runProbe(`
        var other = { x: 42, m: function () { return 7; } };
        var empty = {};
        class Base {
          constructor(a, o) { this.x = a; return o; }
          m() { return 1; }
        }
        var r = 0;
        var c = new Base(3, other);
        r += (c.x === 42) ? 1 : 0;
        r += (c.m() === 7) ? 2 : 0;
        var d = new Base(3, empty);
        r += (typeof d.x === "undefined") ? 4 : 0;
        r += (d.x === undefined) ? 8 : 0;
        r += (typeof d.m === "undefined") ? 16 : 0;
        __r = r;
      `),
    ).toBe(13);
  });

  it("RESIDUAL (base 2, node 15): `this.m()` in a derived frame after an overriding super() hits the nominal receiver guard", async () => {
    // `this.v` reads the override object (bit 1); `this.w = 5` writes the
    // discarded struct (bit 2 only observes that it does not throw); the
    // declared-method call throws TypeError (10000) instead of calling the
    // override object's own `getV`.
    expect(
      await runProbe(`
        var flag = true;
        var r = 0;
        class Base { constructor(v){ this.v = v; if (flag) return { v: -1, getV: function () { return -1; } }; } getV() { return this.v; } }
        class Sub extends Base {
          constructor(v){
            super(v);
            try { r += (this.v === -1) ? 1 : 0; } catch (e) { r += 100; }
            try { this.w = 5; r += 2; } catch (e) { r += 1000; }
            try { r += (this.getV() === -1) ? 4 : 0; } catch (e) { r += 10000; }
          }
        }
        try { var t = new Sub(3); r += (t.v === -1) ? 8 : 0; } catch (e) { r += 100000; }
        __r = r;
      `),
    ).toBe(10011);
  });
});
