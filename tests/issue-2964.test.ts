import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2964 — for-in over a dynamic `$Object` must enumerate INHERITED enumerable
// string keys from the prototype chain (§14.7.5.9 EnumerateObjectProperties),
// not just own keys. Before this fix the standalone for-in path routed through
// `__object_keys` (OWN-only, Object.keys semantics), so inherited enumerable
// keys were never visited. This adds `__object_keys_forin`: per-level ordered
// own keys (OrdinaryOwnPropertyKeys — integer-index ascending then insertion
// order, #1837) followed by a `$proto` walk with shadow-skip (a closer-level
// own property — enumerable OR non-enumerable — shadows the same name deeper in
// the chain). Object.keys stays OWN-only.
//
// Standalone target so the assertions run on the native object runtime
// (`__object_keys_forin` + `__obj_ordered`/`__obj_ordered_all`), not the JS
// host `__for_in_*` imports. `mk()` yields genuine dynamic `$Object` receivers.
//
// Native strings do not marshal back across the wasm boundary as JS strings, so
// each test concatenates the enumerated keys and does the equality check INSIDE
// wasm, returning a discriminating number (1 = expected order).
async function runStandalone(body: string): Promise<unknown> {
  const src = `function mk(): any { return {}; }\n${body}`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2964 — for-in prototype-chain enumeration + integer-key ordering", () => {
  it("visits own enumerable keys then inherited enumerable keys", async () => {
    // own `b` first, then proto `a` — result "ba"; "b" alone = own-only bug.
    expect(
      await runStandalone(`
        export function test(): number {
          const proto: any = mk(); proto.a = 1;
          const o: any = Object.create(proto);
          o.b = 2;
          let s = ""; for (const k in o) { s += k; }
          return s === "ba" ? 1 : (s === "b" ? 2 : 9);
        }`),
    ).toBe(1);
  });

  it("acceptance example 1: Object.create(proto, { b: enumerable }) visits b then a", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const proto: any = mk(); proto.a = 1;
          const o: any = Object.create(proto, { b: { value: 2, enumerable: true } });
          let s = ""; for (const k in o) { s += k; }
          return s === "ba" ? 1 : 9;
        }`),
    ).toBe(1);
  });

  it("acceptance example 2: integer keys ascending then string keys in insertion order (object literal)", async () => {
    // { b:1, 2:2, a:3, 0:4 } enumerates 0,2,b,a
    expect(
      await runStandalone(`
        export function test(): number {
          const o: any = { b: 1, 2: 2, a: 3, 0: 4 };
          let s = ""; for (const k in o) { s += k; }
          return s === "02ba" ? 1 : 9;
        }`),
    ).toBe(1);
  });

  it("integer-key ascending order also holds for dynamically-built objects", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const o: any = mk();
          o.b = 1; o[2] = 2; o.a = 3; o[0] = 4;
          let s = ""; for (const k in o) { s += k; }
          return s === "02ba" ? 1 : 9;
        }`),
    ).toBe(1);
  });

  it("an own key shadows a same-named enumerable prototype key (yielded once, at own position)", async () => {
    // receiver: b, a ; proto: b, c → b(own), a(own), c(proto). b not duplicated.
    expect(
      await runStandalone(`
        export function test(): number {
          const proto: any = mk(); proto.b = 1; proto.c = 2;
          const o: any = Object.create(proto);
          o.b = 3; o.a = 4;
          let s = ""; for (const k in o) { s += k; }
          return s === "bac" ? 1 : (s === "babc" ? 2 : 9);
        }`),
    ).toBe(1);
  });

  it("non-enumerable prototype keys are skipped", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const proto: any = mk();
          Object.defineProperty(proto, "hidden", { value: 1, enumerable: false });
          proto.vis = 2;
          const o: any = Object.create(proto);
          o.own = 3;
          let s = ""; for (const k in o) { s += k; }
          return s === "ownvis" ? 1 : (s === "ownvishidden" ? 2 : 9);
        }`),
    ).toBe(1);
  });

  it("a non-enumerable OWN property shadows an enumerable prototype key (neither is visited)", async () => {
    // own `x` is non-enumerable → not yielded, but it shadows proto `x` too.
    expect(
      await runStandalone(`
        function mkChild(p: any): any { return Object.create(p); }
        export function test(): number {
          const proto: any = mk(); proto.x = 1; proto.y = 2;
          const o: any = mkChild(proto);
          Object.defineProperty(o, "x", { value: 9, enumerable: false });
          let s = ""; for (const k in o) { s += k; }
          return s === "y" ? 1 : (s === "yx" ? 2 : (s === "xy" ? 3 : 9));
        }`),
    ).toBe(1);
  });

  it("counts every visited key across a two-level chain", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const proto: any = mk(); proto.a = 1;
          const o: any = Object.create(proto);
          o.b = 2;
          let n = 0; for (const k in o) { n++; }
          return n;
        }`),
    ).toBe(2);
  });

  it("Object.keys stays OWN-only (no prototype-chain leakage)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const proto: any = mk(); proto.a = 1;
          const o: any = Object.create(proto);
          o.b = 2; o.c = 3;
          const ks: any = Object.keys(o);
          let s = ""; for (let i = 0; i < ks.length; i++) { s += ks[i]; }
          return s === "bc" ? 1 : (s === "bca" ? 2 : 9);
        }`),
    ).toBe(1);
  });

  it("empty object with a plain-object prototype yields nothing", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const o: any = mk();
          let n = 0; for (const k in o) { n++; }
          return n;
        }`),
    ).toBe(0);
  });
});
