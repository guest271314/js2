// #2984 ("builtin receiver + non-literal key") — standalone
// `Object.getOwnPropertyDescriptor(<Ctor>, Symbol.species)` synthesizes the
// spec ACCESSOR descriptor instead of hard-CEing through the `__get_builtin`
// standalone refusal (#1472 Phase B).
//
// Root cause: both compile-time gOPD synthesis gates (Phase-3 builtin-static +
// the #2874 struct key dispatch) require a LITERAL key; `Symbol.species` is a
// PropertyAccessExpression, so the shape fell through to the dynamic fallback,
// which routes a builtin-identifier receiver through `__get_builtin` — a hard
// CE standalone (26 tests: built-ins/*/Symbol.species/*).
//
// Fix: recognize the well-known `Symbol.species` key syntactically and emit
// `__create_accessor_descriptor(<per-ctor "get [Symbol.species]" singleton>,
// undefined, {e:false, c:true})` for the @@species-owner ctors
// (Array/ArrayBuffer/SharedArrayBuffer/Map/Set/Promise/RegExp). The getter
// body is spec step 1: "Return the this value". Non-owner receivers and other
// symbol keys keep the loud refusal (strictly additive — every intercepted
// shape CE'd before).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  return (await compile(src, { target: "standalone" })) as {
    success: boolean;
    errors: { message: string }[];
    binary: Uint8Array;
  };
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await compileStandalone(src);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#2984 standalone gOPD(<Ctor>, Symbol.species) accessor-descriptor synthesis", () => {
  it("returns an accessor descriptor: function get, undefined set, e:false c:true", async () => {
    const ret = await runStandalone(`
      var desc: any = Object.getOwnPropertyDescriptor(Array, Symbol.species);
      export function test(): number {
        if (typeof desc.get !== "function") return 2;
        if (desc.set !== undefined) return 3;
        if (desc.enumerable !== false) return 4;
        if (desc.configurable !== true) return 5;
        if (desc.hasOwnProperty("value") !== false) return 6;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("`.get` is identity-stable across repeated gOPD calls (per-ctor singleton)", async () => {
    const ret = await runStandalone(`
      var a: any = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
      var b: any = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
      export function test(): number { return a.get === b.get ? 1 : 0; }
    `);
    expect(ret).toBe(1);
  });

  it("each ctor owns a DISTINCT getter function (Array's !== Map's)", async () => {
    const ret = await runStandalone(`
      var a: any = Object.getOwnPropertyDescriptor(Array, Symbol.species);
      var m: any = Object.getOwnPropertyDescriptor(Map, Symbol.species);
      export function test(): number { return a.get !== m.get ? 1 : 0; }
    `);
    expect(ret).toBe(1);
  });

  it("getter meta: name 'get [Symbol.species]' (§10.2.9), length 0", async () => {
    const ret = await runStandalone(`
      var desc: any = Object.getOwnPropertyDescriptor(RegExp, Symbol.species);
      export function test(): number {
        var g: any = desc.get;
        if (g.length !== 0) return 2;
        if (g.name !== "get [Symbol.species]") return 3;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("reflective gOPD on the getter's own length answers spec attributes (propertyHelper shape)", async () => {
    const ret = await runStandalone(`
      var desc: any = Object.getOwnPropertyDescriptor(ArrayBuffer, Symbol.species);
      var d2: any = Object.getOwnPropertyDescriptor(desc.get, "length");
      export function test(): number {
        if (d2 === undefined) return 2;
        if (d2.value !== 0) return 3;
        if (d2.writable !== false) return 4;
        if (d2.configurable !== true) return 5;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("alias receiver resolves through the conservative reaching-def resolver", async () => {
    const ret = await runStandalone(`
      var s = Set;
      var desc: any = Object.getOwnPropertyDescriptor(s, Symbol.species);
      export function test(): number {
        return typeof desc.get === "function" && desc.set === undefined ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("GUARD: non-@@species-owner builtin receiver keeps the loud refusal (no phantom descriptor)", async () => {
    const r = await compileStandalone(`
      var desc = Object.getOwnPropertyDescriptor(Math, Symbol.species);
      export function test(): number { return 1; }
    `);
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/__get_builtin/);
  });

  it("GUARD: shadowed Symbol is NOT treated as the well-known key", async () => {
    // A local `Symbol` binding means `Symbol.species` is a user value — the
    // synthesis must decline (shape keeps today's refusal-CE path).
    const r = await compileStandalone(`
      export function test(): number {
        var Symbol: any = { species: "x" };
        var desc: any = Object.getOwnPropertyDescriptor(Array, Symbol.species);
        return desc === undefined ? 1 : 0;
      }
    `);
    // Declining the arm is the contract; whether the fallback compiles or
    // refuses is the dynamic path's business. Assert only that when it DOES
    // compile, no accessor descriptor was fabricated.
    if (r.success) {
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const ret = (instance.exports as Record<string, () => unknown>).test?.();
      expect(ret).toBe(1);
    }
  });

  it("host/gc lane unchanged: the shape still compiles with host imports", async () => {
    const r = (await compile(
      `
      var desc: any = Object.getOwnPropertyDescriptor(Array, Symbol.species);
      export function test(): number { return 1; }
    `,
      { fileName: "test.ts" },
    )) as { success: boolean; errors: { message: string }[] };
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
