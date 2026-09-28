/**
 * #6651 cluster A, slice A11 — generator rows that compiled but computed the
 * wrong VALUE in standalone.
 *
 * Group 1, the method-receiver model. A method called WITHOUT its object:
 *
 *  - an object-literal method's receiver is the literal's closed struct, so an
 *    extracted call (`var f = obj.m; f()`) reached the body with a null struct
 *    and a bare `this` read as JS `null`. §10.2.1.2 OrdinaryCallBindThis binds
 *    the global object in sloppy code and `undefined` in strict code
 *    (`method-definition/{generator,name}-invoke-fn-{strict,no-strict}.js`);
 *  - a class generator method's function value (`C.prototype.gen`) returned
 *    its private `$GenState` struct, which no dynamic call arm matches ("not a
 *    function"), and the #2025 null-receiver TypeError fired because the
 *    generator FACTORY stores param 0 into its frame even when the body never
 *    reads `this` (`class/gen-method/yield-spread-arr-*.js`).
 *
 * Every case is RED on the base commit except the ones marked GUARD, which pin
 * that the new arms do not fire where they must not (green on base too). All
 * run standalone and assert the binary imports NOTHING.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(body: string, prelude = "", strict = false): Promise<unknown> {
  const src = `${strict ? '"use strict";\n' : ""}${prelude}\nexport function test(): any {\n${body}\n}`;
  const r = (await compile(src, {
    fileName: "t.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const GLOBAL = "var global: any = (function () { return this; })();";

describe("#6651 A11 · group 1 · an extracted object-literal method binds the caller's receiver", () => {
  it("sloppy generator method called bare: `this` is the global object", async () => {
    const prelude = `${GLOBAL}
var thisValue: any = null;
var method: any = { *method() { thisValue = this; } }.method;
method().next();`;
    expect(await run("return thisValue === global ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("generator method with its own 'use strict' called bare: `this` is undefined", async () => {
    const prelude = `var thisValue: any = null;
var method: any = { *method() { 'use strict'; thisValue = this; } }.method;
method().next();`;
    expect(await run("return thisValue === undefined ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("sloppy plain method called bare: `this` is the global object", async () => {
    const prelude = `${GLOBAL}
var thisValue: any = null;
var method: any = { method() { thisValue = this; } }.method;
method();`;
    expect(await run("return thisValue === global ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("plain method with its own 'use strict' called bare: `this` is undefined", async () => {
    const prelude = `var thisValue: any = null;
var method: any = { method() { 'use strict'; thisValue = this; } }.method;
method();`;
    expect(await run("return thisValue === undefined ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("a plain method invoked with a foreign receiver sees that receiver", async () => {
    const prelude = `var thisValue: any = null;
var other: any = { z: 1 };
var method: any = { method() { thisValue = this; } }.method;
method.call(other);`;
    expect(await run("return thisValue === other ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("GUARD: a bound call still sees its own object, bare and through `this.x`", async () => {
    const prelude = `var seen: any = null;
var obj: any = { v: 5, m() { seen = this; return this.v; }, *g() { seen = this; yield this.v; } };`;
    const body = `var s = 0;
if (obj.m() === 5 && seen === obj) s += 1;
seen = null;
var r = obj.g().next();
if (r.value === 5 && seen === obj) s += 10;
return s;`;
    expect(await run(body, prelude)).toBe(11);
  });
});

describe("#6651 A11 · group 1 · an extracted class generator method is callable", () => {
  it("`var gen = C.prototype.gen; gen()` drives the body (it threw before the body ran)", async () => {
    const prelude = `class C { *gen() { yield 1; } }
var gen: any = C.prototype.gen;`;
    expect(await run("var r = gen().next(); return r.value === 1 && r.done === false ? 1 : 0;", prelude)).toBe(1);
  });

  it("the yield-spread-arr row shape: an unbound class generator method re-yields a sent array", async () => {
    const prelude = `var arr: any = ['a', 'b', 'c'];
var callCount = 0;
class C { *gen(): any { callCount += 1; yield [...(yield)]; } }
var gen: any = C.prototype.gen;`;
    const body = `var iter = gen();
iter.next(false);
var item = iter.next(arr);
var value = item.value;
return value !== arr && value.length === 3 && value[0] === 'a' && value[2] === 'c' && item.done === false && callCount === 1 ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: an unbound class generator method that READS `this` still throws a catchable TypeError", async () => {
    const prelude = `class C { x = 1; *gen() { yield this.x; } }
var gen: any = C.prototype.gen;`;
    const body = `try { gen().next(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: the same method called through an instance still yields", async () => {
    const prelude = `class C { *gen() { yield 1; } }`;
    expect(await run("return new C().gen().next().value === 1 ? 1 : 0;", prelude)).toBe(1);
  });
});
