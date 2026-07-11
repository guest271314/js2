// #2992 (slice 3) — standalone defineProperty partial-descriptor MERGE +
// accessor define→gOPD fidelity (§10.1.6.3 ValidateAndApplyPropertyDescriptor).
//
// Root causes fixed (all standalone; gc/host lane byte-inert):
//  1. `__defineProperty_value` / `__defineProperty_accessor` blanket-inserted
//     (value, this-call's flag bits) on REDEFINE — a partial descriptor reset
//     every unspecified attribute to false, clobbered the current [[Value]]
//     with null on a flags-only define, and wiped FLAG_ACCESSOR (+ the live
//     get/set halves) off accessor properties. Both appliers now MERGE in
//     place per §10.1.6.3 (specified-bits gate every attribute write).
//  2. The accessor applier had no [[Get]]/[[Set]] presence signal — flag word
//     bits 8/9 now carry "get/set specified" (standalone-gated at call sites;
//     callers that set neither bit keep the legacy replace-both meaning).
//  3. `get: someIdentifier` re-synthesized a FRESH closure from the AST, so
//     gOPD read back a different function object (`desc.get === getFunc` was
//     always false). The identifier's VALUE is now compiled directly.
//  4. Explicit `get: undefined` / `set: undefined` were DROPPED at the call
//     site (treated as no accessor) — they are PRESENT accessor fields per
//     ToPropertyDescriptor and now create/merge an accessor property whose
//     halves read back as undefined (15.2.3.6-4-439).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, target: "gc" | "standalone"): Promise<any> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    target,
    skipSemanticDiagnostics: true,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as any).test?.();
}

for (const target of ["gc", "standalone"] as const) {
  describe(`#2992 S3 — partial-descriptor merge + accessor fidelity (${target})`, () => {
    it("flags-only redefine preserves the data value and unspecified attributes", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  Object.defineProperty(o, "p", { value: 2010, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(o, "p", { enumerable: false });
  var d: any = Object.getOwnPropertyDescriptor(o, "p");
  return (o.p === 2010 && d.value === 2010 && d.writable === true && d.enumerable === false && d.configurable === true) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("get-only redefine preserves the live setter (15.2.3.6-4-107 shape)", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  var backing: any = 0;
  var g1: any = function() { return 10; };
  var s1: any = function(v: any) { backing = v; };
  var d1: any = { get: g1, set: s1, configurable: true };
  Object.defineProperty(o, "foo", d1);
  var g2: any = function() { return 20; };
  var d2: any = { get: g2 };
  Object.defineProperty(o, "foo", d2);
  o.foo = 99;
  return (o.foo === 20 && backing === 99) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("flags-only redefine of an accessor preserves both halves (15.2.3.6-4-82-* shape)", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  var g1: any = function() { return 10; };
  var d1: any = { get: g1, enumerable: true, configurable: true };
  Object.defineProperty(o, "foo", d1);
  var d2: any = { enumerable: false };
  Object.defineProperty(o, "foo", d2);
  var d: any = Object.getOwnPropertyDescriptor(o, "foo");
  return (o.foo === 10 && d.enumerable === false && d.configurable === true && d.get === g1) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("gOPD preserves getter identity (desc.get === getFunc)", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  var g: any = function() { return 41; };
  Object.defineProperty(o, "p", { get: g, enumerable: false, configurable: true });
  var d: any = Object.getOwnPropertyDescriptor(o, "p");
  return d.get === g ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("explicit { get: undefined, set: undefined } creates an accessor visible to gOPD (15.2.3.6-4-439)", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  Object.defineProperty(o, "prop", { get: undefined, set: undefined, enumerable: true, configurable: false });
  var desc1: any = Object.getOwnPropertyDescriptor(o, "prop");
  var threw = 0;
  try { Object.defineProperty(o, "prop", { value: 1001 } as any); } catch (e) { threw = 1; }
  var desc2: any = Object.getOwnPropertyDescriptor(o, "prop");
  return (threw === 1 && desc1.hasOwnProperty("get") && desc1.get === undefined && desc2.hasOwnProperty("value") === false && o.hasOwnProperty("prop")) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("non-configurable accessor rejects a getter change with TypeError", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  var g1: any = function() { return 10; };
  var d1: any = { get: g1, configurable: false };
  Object.defineProperty(o, "foo", d1);
  var g2: any = function() { return 20; };
  var d2: any = { get: g2 };
  var threw = 0;
  try { Object.defineProperty(o, "foo", d2); } catch (e) { threw = 1; }
  return (threw === 1 && o.foo === 10) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("configurable accessor→data conversion drops the halves and installs the value", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  var g: any = function() { return 41; };
  Object.defineProperty(o, "p", { get: g, configurable: true });
  Object.defineProperty(o, "p", { value: 9 });
  var d: any = Object.getOwnPropertyDescriptor(o, "p");
  return (o.p === 9 && d.get === undefined && d.value === 9 && d.writable === false) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("data-value redefine and defaults-false on a fresh define keep working (no merge over-reach)", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  Object.defineProperty(o, "p", { value: 1, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(o, "p", { value: 2 });
  Object.defineProperty(o, "n", { value: 5 });
  var d: any = Object.getOwnPropertyDescriptor(o, "n");
  return (o.p === 2 && d.value === 5 && d.writable === false && d.enumerable === false && d.configurable === false) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("defineProperties plural accessor apply keeps working (merge bits ride the plural path)", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  var g: any = function() { return 2; };
  Object.defineProperties(o, { a: { value: 1, enumerable: true }, b: { get: g } } as any);
  var d: any = Object.getOwnPropertyDescriptor(o, "b");
  return (o.a === 1 && o.b === 2 && d.get === g) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });
  });
}
