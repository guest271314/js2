// (#2984 "primitive-string(s)") Standalone gOPD with a NON-$Object receiver:
// §19.1.2.8 ToObject semantics in the `__getOwnPropertyDescriptor` native —
// undefined/null throw TypeError, a primitive string answers its §10.4.3
// String-exotic own properties (index/length), other primitives answer
// `undefined`. (test262: 15.2.3.3-1-{1,2}, primitive-string.js)
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2984 primitive receivers: gOPD ToObject semantics (standalone)", () => {
  it("index descriptor on a primitive string: {value: char, w:false, e:true, c:false}", async () => {
    const out = await runStandalone(
      `var d: any = Object.getOwnPropertyDescriptor('foo', '0');
       export function test() {
         if (d === undefined) return -1;
         return (d.value === 'f' ? 1 : 0) + (d.writable === false ? 2 : 0) +
                (d.enumerable === true ? 4 : 0) + (d.configurable === false ? 8 : 0);
       }`,
    );
    expect(out).toBe(15);
  });

  it("length descriptor on a primitive string: {value: len, all false}", async () => {
    const out = await runStandalone(
      `var d: any = Object.getOwnPropertyDescriptor('foo', 'length');
       export function test() {
         if (d === undefined) return -1;
         return (d.value === 3 ? 1 : 0) + (d.writable === false ? 2 : 0) +
                (d.enumerable === false ? 4 : 0) + (d.configurable === false ? 8 : 0);
       }`,
    );
    expect(out).toBe(15);
  });

  it("numeric key is ToPropertyKey'd (gOPD('foo', 0))", async () => {
    const out = await runStandalone(
      `var d: any = Object.getOwnPropertyDescriptor('foo', 0);
       export function test() { return d === undefined ? -1 : (d.value === 'f' ? 1 : 0); }`,
    );
    expect(out).toBe(1);
  });

  it("out-of-range index and empty string answer undefined", async () => {
    const out = await runStandalone(
      `var d1: any = Object.getOwnPropertyDescriptor('foo', '5');
       var d2: any = Object.getOwnPropertyDescriptor('', '0');
       export function test() { return (d1 === undefined ? 1 : 0) + (d2 === undefined ? 2 : 0); }`,
    );
    expect(out).toBe(3);
  });

  it("undefined receiver throws a catchable TypeError (15.2.3.3-1-1)", async () => {
    const out = await runStandalone(
      `export function test() {
         try { Object.getOwnPropertyDescriptor(undefined as any, 'x'); return 0; }
         catch (e) { return e instanceof TypeError ? 1 : 2; }
       }`,
    );
    expect(out).toBe(1);
  });

  it("null receiver throws a catchable TypeError (15.2.3.3-1-2)", async () => {
    const out = await runStandalone(
      `export function test() {
         try { Object.getOwnPropertyDescriptor(null as any, 'x'); return 0; }
         catch (e) { return e instanceof TypeError ? 1 : 2; }
       }`,
    );
    expect(out).toBe(1);
  });

  it("GUARD: number receiver answers undefined (wrapper owns no props)", async () => {
    const out = await runStandalone(
      `var d: any = Object.getOwnPropertyDescriptor(5 as any, 'x');
       export function test() { return d === undefined ? 1 : 0; }`,
    );
    expect(out).toBe(1);
  });

  it("GUARD: $Object receivers keep the ordinary walk (no behavior change)", async () => {
    const out = await runStandalone(
      `var obj: any = {};
       Object.defineProperty(obj, 'p', { value: 9, writable: true, enumerable: true, configurable: true });
       var d: any = Object.getOwnPropertyDescriptor(obj, 'p');
       export function test() { return d === undefined ? -1 : (d.value === 9 ? 1 : 0); }`,
    );
    expect(out).toBe(1);
  });
});
