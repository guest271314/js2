// #3116 — Array exotic [[DefineOwnProperty]]: defineProperty(ies) element and
// length writes must land in the native vec (visible to both static and
// dynamic reads), with the §10.1.6.3 validation matrix and §10.4.2.1
// ArraySetLength semantics on the runtime lanes.
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(src: string): Promise<number> {
  const exports = await compileToWasm(src);
  return (exports.test as () => number)();
}

describe("#3116 array-exotic defineProperty vec write-back", () => {
  it("plural defineProperties element define is visible to element reads", async () => {
    expect(
      await run(`
      export function test(): number {
        var arr: any = [undefined];
        Object.defineProperties(arr, { "0": { value: 12 } });
        return (arr[0] === 12 ? 1 : 0) * 10 + (arr.length === 1 ? 1 : 0);
      }`),
    ).toBe(11);
  });

  it("singular element define on statically-typed array is visible to reads", async () => {
    expect(
      await run(`
      export function test(): number {
        var arr = [1, 2];
        Object.defineProperty(arr, "0", { value: 42 });
        return ((arr as any)[0] === 42 ? 1 : 0) * 10 + (arr.length === 2 ? 1 : 0);
      }`),
    ).toBe(11);
  });

  it("define beyond length extends the array", async () => {
    expect(
      await run(`
      export function test(): number {
        var arr: any = [];
        Object.defineProperty(arr, "0", { value: 7, writable: true, enumerable: true, configurable: true });
        return (arr[0] === 7 ? 1 : 0) * 10 + (arr.length === 1 ? 1 : 0);
      }`),
    ).toBe(11);
  });

  it("ArraySetLength: invalid length throws RangeError (plural runtime lane)", async () => {
    expect(
      await run(`
      export function test(): number {
        var arr = [];
        var threw = 0;
        try { Object.defineProperties(arr, { length: { value: -1 } }); } catch (e) { threw = 1; }
        return threw;
      }`),
    ).toBe(1);
  });

  it("ArraySetLength: plural length shrink applies to length reads", async () => {
    expect(
      await run(`
      export function test(): number {
        var arr: any = [1, 2, 3];
        Object.defineProperties(arr, { length: { value: 1 } });
        return (arr.length === 1 ? 1 : 0);
      }`),
    ).toBe(1);
  });

  it("non-writable non-configurable element: SameValue-different redefine throws, value kept", async () => {
    expect(
      await run(`
      export function test(): number {
        var arrObj: any = [];
        Object.defineProperty(arrObj, 0, { value: 101, writable: false, configurable: false });
        var threw = 0;
        try { Object.defineProperty(arrObj, "0", { value: "abc" }); } catch (e) { threw = 1; }
        return threw * 1000 + (arrObj[0] === 101 ? 1 : 0);
      }`),
    ).toBe(1001);
  });

  it("existing element redefine on non-configurable non-writable index throws (seeded default descriptor)", async () => {
    expect(
      await run(`
      export function test(): number {
        var arr: any = [5];
        Object.defineProperty(arr, "0", { writable: false, configurable: false });
        var threw = 0;
        try { Object.defineProperty(arr, "0", { value: 9 }); } catch (e) { threw = 1; }
        return threw * 10 + (arr[0] === 5 ? 1 : 0);
      }`),
    ).toBe(11);
  });

  it("length shrink stops at a non-configurable element and throws", async () => {
    expect(
      await run(`
      export function test(): number {
        var arr: any = [0, 1, 2];
        Object.defineProperty(arr, "1", { value: 1, configurable: false });
        var threw = 0;
        try { Object.defineProperty(arr, "length", { value: 0 }); } catch (e) { threw = 1; }
        return threw * 100 + arr.length;
      }`),
    ).toBe(102);
  });

  it("get: null in a defineProperties descriptor throws TypeError (not a silent data define)", async () => {
    expect(
      await run(`
      export function test(): number {
        var obj = {};
        var threw = 0;
        try { Object.defineProperties(obj, { property: { get: null as any } }); } catch (e) { threw = 1; }
        return threw;
      }`),
    ).toBe(1);
  });

  it("static redefine after a runtime-descriptor define validates against sidecar state (+0 vs -0)", async () => {
    expect(
      await run(`
      export function test(): number {
        var obj: any = {};
        var desc: any = { value: +0 };
        Object.defineProperty(obj, "foo", desc);
        var threw = 0;
        try { Object.defineProperties(obj, { foo: { value: -0 } }); } catch (e) { threw = 1; }
        return threw;
      }`),
    ).toBe(1);
  });
});
