// #2106 S1 — standalone `$undefined` tag-1 singleton regime (flag-gated).
//
// Under `undefinedSingleton: true` (standalone/wasi only), `undefined` is the
// extern-wrapped tag-1 `$AnyValue` singleton and `null` stays
// `ref.null.extern` — so the two are DISTINCT for `===`/`typeof`/ToNumber/
// ToString, while every nullish consumer (`==`, `??`, `?.`, defaults,
// truthiness) still catches both. Flag OFF is the legacy conflated regime and
// must stay byte-identical (regression-netted here by a behavioral control:
// the legacy `null === undefined` answers TRUE standalone).
//
// Each case compiles with `target: "wasi"` + the flag, instantiates against
// the WASI polyfill, and returns an i32 score from `test()`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function run(source: string, undefinedSingleton: boolean): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi", undefinedSingleton });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  return (exports.test as () => number)();
}

describe("#2106 S1 undefined singleton (flag ON, standalone)", () => {
  it("strict equality: undefined===undefined across producers; null===null; null!==undefined", async () => {
    const v = await run(
      `export function test(): number {
         const u: any = undefined;
         const miss: any = ({} as any).nope;
         const n: any = null;
         let s = 0;
         if (u === miss) s += 1;        // two undefined producers agree
         if (n === null) s += 2;
         if (!(n === u)) s += 4;        // null !== undefined
         if (!(u === null)) s += 8;
         if (u === undefined) s += 16;
         if (!(n === undefined)) s += 32;
         return s;
       }`,
      true,
    );
    expect(v).toBe(63);
  });

  it("loose equality: null == undefined true; nullish vs non-nullish false", async () => {
    const v = await run(
      `export function test(): number {
         const u: any = undefined;
         const n: any = null;
         const z: any = 0;
         let s = 0;
         if (u == n) s += 1;
         if (n == u) s += 2;
         if (!(n == z)) s += 4;
         if (!(u == z)) s += 8;
         if (u == null) s += 16;
         if (n == null) s += 32;
         return s;
       }`,
      true,
    );
    expect(v).toBe(63);
  });

  it("typeof: undefined → 'undefined', null → 'object'", async () => {
    const v = await run(
      `export function test(): number {
         const u: any = undefined;
         const n: any = null;
         const miss: any = ({} as any).nope;
         let s = 0;
         if (typeof u === "undefined") s += 1;
         if (typeof n === "object") s += 2;
         if (typeof miss === "undefined") s += 4;
         if (!(typeof n === "undefined")) s += 8;
         return s;
       }`,
      true,
    );
    expect(v).toBe(15);
  });

  it("property reads: missing → undefined; stored null stays null", async () => {
    const v = await run(
      `export function test(): number {
         const o: any = { a: null };
         let s = 0;
         if (o.a === null) s += 1;
         if (!(o.a === undefined)) s += 2;
         if (o.b === undefined) s += 4;
         if (!(o.b === null)) s += 8;
         return s;
       }`,
      true,
    );
    expect(v).toBe(15);
  });

  it("destructuring defaults fire for undefined/missing, NOT for null (§13.15.5.3)", async () => {
    const v = await run(
      `export function test(): number {
         const src: any = {};
         const { a = 7 } = src;
         // NOTE: a null property must come from a $Object (dynamic set) —
         // a { b: null } shape-struct literal read through __extern_get is a
         // pre-existing miss in BOTH regimes (flag-neutral, not S1 scope).
         const srcN: any = {};
         (srcN as any).b = null;
         const { b = 9 } = srcN;
         let s = 0;
         if (a === 7) s += 1;
         if (b === null) s += 2;   // default must NOT fire for null
         if (!(b === 9)) s += 4;
         return s;
       }`,
      true,
    );
    expect(v).toBe(7);
  });

  it("?? and ?. and truthiness treat the singleton as nullish/falsy", async () => {
    const v = await run(
      `export function test(): number {
         const u: any = undefined;
         const n: any = null;
         let s = 0;
         if ((u ?? 5) === 5) s += 1;
         if ((n ?? 6) === 6) s += 2;
         if (u?.x === undefined) s += 4;
         if (!u) s += 8;            // ToBoolean(undefined) = false
         if (!n) s += 16;
         const zero: any = 0;
         if ((zero ?? 7) === 0) s += 32; // 0 is not nullish
         return s;
       }`,
      true,
    );
    expect(v).toBe(63);
  });

  it("ToString / ToNumber split: 'undefined' vs 'null', NaN vs 0", async () => {
    const v = await run(
      `export function test(): number {
         const u: any = undefined;
         const n: any = null;
         let s = 0;
         if ("v=" + u === "v=undefined") s += 1;
         if ("v=" + n === "v=null") s += 2;
         const nu = +n;
         if (nu === 0) s += 4;      // Number(null) = 0
         const uu = +u;
         if (uu !== uu) s += 8;     // Number(undefined) = NaN
         return s;
       }`,
      true,
    );
    expect(v).toBe(15);
  });

  it("destructure of an undefined container throws TypeError (§13.15.5)", async () => {
    const v = await run(
      `export function test(): number {
         const f = ({ a }: any): any => a;
         const u: any = undefined;
         let r = 0;
         try { f(u); r = 0; } catch (e) { r = 1; }
         return r;
       }`,
      true,
    );
    expect(v).toBe(1);
  });
});

describe("#2106 S1 flag OFF (legacy control — proves the gate)", () => {
  it("legacy standalone conflates: null === undefined answers true", async () => {
    const v = await run(
      `export function test(): number {
         const u: any = undefined;
         const n: any = null;
         return typeof n === "undefined" && !(typeof n === "object") ? 1 : 0;
       }`,
      false,
    );
    // Legacy: null and undefined share ref.null.extern → typeof null is
    // "undefined" standalone. This control locks the flag-off behavior so an
    // accidental default-flip cannot slip through this suite silently.
    expect(v).toBe(1);
  });
});
