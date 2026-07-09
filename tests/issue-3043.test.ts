// #3043 — Object.defineProperty ValidateAndApplyPropertyDescriptor: the
// accessor-static-lane transition matrix. An accessor `defineProperty` records
// its descriptor flags in the compile-time table but previously routed a later
// attribute-only or get/set redefine through a path that skipped §10.1.6.3
// validation, so illegal transitions on a NON-configurable accessor were
// silently accepted. Unify all define lowerings on `definedPropertyFlags` +
// a shared compile-time transition check.
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function threw(body: string): Promise<number> {
  const exports = await compileToWasm(`export function test(): number {
    ${body}
    return threw;
  }`);
  return (exports.test as () => number)();
}

describe("#3043 defineProperty accessor transition validation", () => {
  it("accessor configurable:false → {configurable:true} throws TypeError", async () => {
    expect(
      await threw(`var o: any = {};
        Object.defineProperty(o, "foo", { set: function (v: any) {}, configurable: false });
        var threw = 0;
        try { Object.defineProperty(o, "foo", { configurable: true }); } catch (e) { threw = 1; }`),
    ).toBe(1);
  });

  it("data configurable:false → accessor {get} throws (data↔accessor flip)", async () => {
    expect(
      await threw(`var o: any = {};
        Object.defineProperty(o, "foo", { value: 1, configurable: false });
        var threw = 0;
        try { Object.defineProperty(o, "foo", { get: function () { return 2; } }); } catch (e) { threw = 1; }`),
    ).toBe(1);
  });

  it("non-configurable accessor → different set fn throws", async () => {
    expect(
      await threw(`var o: any = {};
        Object.defineProperty(o, "foo", { set: function (v: any) {}, configurable: false });
        var threw = 0;
        try { Object.defineProperty(o, "foo", { set: function (v: any) {} }); } catch (e) { threw = 1; }`),
    ).toBe(1);
  });

  it("non-configurable accessor → enumerable toggle throws", async () => {
    expect(
      await threw(`var o: any = {};
        Object.defineProperty(o, "foo", { get: function () { return 1; }, enumerable: true, configurable: false });
        var threw = 0;
        try { Object.defineProperty(o, "foo", { enumerable: false }); } catch (e) { threw = 1; }`),
    ).toBe(1);
  });

  // ── legal redefines must NOT throw (false-positive guards) ──

  it("configurable accessor allows any redefine (no throw)", async () => {
    expect(
      await threw(`var o: any = {};
        Object.defineProperty(o, "x", { get: function () { return 1; }, configurable: true });
        var threw = 0;
        try { Object.defineProperty(o, "x", { get: function () { return 2; }, configurable: false }); } catch (e) { threw = 1; }`),
    ).toBe(0);
  });

  it("non-configurable accessor: bare same-attribute redefine does not throw", async () => {
    expect(
      await threw(`var o: any = {};
        Object.defineProperty(o, "x", { get: function () { return 1; }, enumerable: true, configurable: false });
        var threw = 0;
        try { Object.defineProperty(o, "x", { enumerable: true }); } catch (e) { threw = 1; }`),
    ).toBe(0);
  });

  it("configurable data → accessor redefine does not throw", async () => {
    expect(
      await threw(`var o: any = {};
        Object.defineProperty(o, "x", { value: 1, configurable: true });
        var threw = 0;
        try { Object.defineProperty(o, "x", { get: function () { return 2; } }); } catch (e) { threw = 1; }`),
    ).toBe(0);
  });

  it("throw on illegal redefine keeps the ORIGINAL accessor intact (540-1 shape)", async () => {
    // First define with identifier-ref get/set; illegal redefine throws; the
    // catch reads the property back through the ORIGINAL getter, which must
    // still be wired (early-return must not clobber the live accessor).
    const exports = await compileToWasm(`export function test(): number {
      var obj: any = {};
      obj.backing = 7;
      var getFunc = function () { return obj.backing; };
      var setFunc = function (v: any) { obj.backing = v; };
      Object.defineProperty(obj, "property", { get: getFunc, set: setFunc, configurable: false });
      var caught = 0;
      var readBack = -1;
      try {
        Object.defineProperty(obj, "property", { get: function () { return 100; } });
      } catch (e) {
        caught = 1;
        readBack = obj.property; // original getter → obj.backing === 7
      }
      return caught * 1000 + readBack;
    }`);
    expect((exports.test as () => number)()).toBe(1007);
  });
});
