// #3319 — standalone gOPD/descriptor "undefined" observability under the
// #2106 $undefined-singleton regime (follow-up to the #3316 residuals).
//
// Mechanism: a gOPD MISS (and every descriptor-synthesis "undefined" slot)
// was materialized as bare `ref.null.extern`. Legacy regime: null externref
// IS undefined, so `=== undefined` held. Under the #2106 default-flip
// (PR #3020) null is DISTINCT from undefined, so:
//   - `gOPD(o, missing) === undefined` answered false (typed-receiver fast
//     path in call-builtin-static.ts, dynamic `__getOwnPropertyDescriptor`
//     miss arms, builtin-static-gopd miss arms) — the issue-2874 /
//     issue-2896 residuals documented in #3316;
//   - `desc.set === undefined` answered false for synthesized intrinsic
//     accessors (`__create_accessor_descriptor` null half);
//   - `get.call(<Builtin>.prototype)` proto-identity arm returned null;
//   - a no-value define (`{writable:true}`) stored null as [[Value]], so
//     `typeof o.p` was "object" instead of "undefined" (§10.1.6.3 fresh
//     define defaults [[Value]] to undefined).
// All sites are regime-gated: legacy standalone (JS2WASM_UNDEF_SINGLETON=0)
// and the gc/host lane keep byte-identical emission.
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
  describe(`#3319 — gOPD miss / descriptor undefined-observability (${target})`, () => {
    // (#3321) The two typed-receiver miss shapes now run on BOTH lanes: the
    // gc/host twin (static miss emitted null extern while host `undefined`
    // is the __get_undefined sentinel) is fixed by routing the miss through
    // `emitUndefined` — see the #3321 issue file.
    it("typed-receiver gOPD miss answers undefined (issue-2874 residual shape)", async () => {
      const ret = await run(
        `export function test(): number {
  const o = { a: 5 };
  const d: any = Object.getOwnPropertyDescriptor(o, 'b');
  return (d === undefined && typeof d === "undefined") ? 1 : 0;
}`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("$Object-receiver gOPD miss answers undefined (dynamic native miss arm)", async () => {
      const ret = await run(
        `export function test(): number {
  var o: any = {};
  o["a"] = 5;
  const d: any = Object.getOwnPropertyDescriptor(o, 'b');
  return d === undefined ? 1 : 0;
}`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("gOPD after delete answers undefined (issue-2896 residual shape)", async () => {
      const ret = await run(
        `export function test(): number {
  const fn: any = Array.isArray;
  const had = Object.getOwnPropertyDescriptor(fn, "name") !== undefined;
  const del = delete fn["name"];
  const gone = Object.getOwnPropertyDescriptor(fn, "name") === undefined;
  return had && del && gone ? 1 : 0;
}`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("gOPD miss is NOT null (undefined and null stay distinct)", async () => {
      const ret = await run(
        `export function test(): number {
  const o = { a: 5 };
  const d: any = Object.getOwnPropertyDescriptor(o, 'b');
  return d === null ? 0 : 1;
}`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("builtin absent-member gOPD answers undefined (builtin-static-gopd miss arm)", async () => {
      const ret = await run(
        `export function test(): number {
  const d: any = Object.getOwnPropertyDescriptor(Math, "caller");
  return d === undefined ? 1 : 0;
}`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("no-value defineProperty stores [[Value]] undefined (typeof + ===)", async () => {
      const ret = await run(
        `export function test(): number {
  var obj = {};
  Object.defineProperty(obj, "p", { writable: true });
  var t: any = obj.p;
  return (t === undefined && typeof t === "undefined") ? 1 : 0;
}`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("no-value defineProperties stores [[Value]] undefined (15.2.3.7-5-b-113 shape)", async () => {
      const ret = await run(
        `function check(actual: any, expected: string): number {
  return actual === expected ? 1 : 0;
}
export function test(): number {
  var obj = {};
  Object.defineProperties(obj, { property: { writable: true } });
  return check(typeof(obj.property), "undefined");
}`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("no-value DYNAMIC descriptor stores [[Value]] undefined (__obj_define_from_desc)", async () => {
      const ret = await run(
        `export function test(): number {
  var obj: any = {};
  obj["q"] = 0;
  var d: any = { enumerable: true };
  Object.defineProperty(obj, "p", d);
  return obj.p === undefined ? 1 : 0;
}`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("explicit { value: null } still reads back null, not undefined", async () => {
      const ret = await run(
        `export function test(): number {
  var obj: any = {};
  obj["q"] = 0;
  Object.defineProperty(obj, "p", { value: null, enumerable: true });
  var d: any = Object.getOwnPropertyDescriptor(obj, "p");
  return (obj.p === null && d.value === null && d.value !== undefined) ? 1 : 0;
}`,
        target,
      );
      expect(ret).toBe(1);
    });
  });
}

// Standalone-only shapes: intrinsic accessor synthesis + §22.2.6 proto identity
// (the gc lane resolves these through real host objects).
describe("#3319 — standalone intrinsic accessor undefined halves", () => {
  it("gOPD(Array, Symbol.species) has set === undefined (__create_accessor_descriptor half)", async () => {
    const ret = await run(
      `export function test(): number {
  const d: any = Object.getOwnPropertyDescriptor(Array, Symbol.species);
  return (typeof d.get === "function" && d.set === undefined) ? 1 : 0;
}`,
      "standalone",
    );
    expect(ret).toBe(1);
  });

  it("RegExp intrinsic getter on the bare prototype returns undefined (§22.2.6 identity arm)", async () => {
    // Same shape as the issue-2885 suite's assertion (direct `.get` off the
    // gOPD expression); an extra any-typed descriptor hop routes the call
    // through a different (pre-existing) dispatch gap — out of scope here.
    const ret = await run(
      `export function test(): number {
  const g = (Object.getOwnPropertyDescriptor(RegExp.prototype, "global") as any).get;
  return g.call(RegExp.prototype) === undefined ? 1 : 0;
}`,
      "standalone",
    );
    expect(ret).toBe(1);
  });
});
