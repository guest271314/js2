// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3309 (G1 of the #2927 generic-built-in audit / #2928 CallBuiltin prereq) —
// Map/Set/WeakMap/WeakSet methods on a genuinely-`any` receiver under
// `--target standalone` / `--target wasi`.
//
// Root cause (corrected from the #2927 audit narrative): the any-receiver
// extern-class first-match scan `tryExternClassMethodOnAny`
// (calls-closures.ts) bound `m.set(k,v)`/`m.get(k)`/`m.has(k)` on an
// `any`-held Map to `env.WeakMap_set`/`_get`/`_has` and `s.add(v)` to
// `env.Set_add` — host imports the standalone runtime cannot satisfy — because
// the lib .d.ts declare-var scan nativeStrings-gates only `"Map"`, leaving
// WeakMap/Set/WeakSet in the candidate pool. The scan returned before the
// #2151 closed-method dispatcher lane was reached, so the WasmGC-native
// Map/Set runtime (map-runtime.ts / set-runtime.ts) sat unused.
//
// Fix: refuse the collection names in the scan under standalone/wasi and add a
// `$Map` brand arm to the closed-method dispatcher. All four collections share
// the `$Map` struct with an immutable `kind` tag (COLLECTION_KIND, #3171), so
// one `ref.test $Map` arm serves them with a per-method kind guard
// (get/set → MAP|WEAKMAP, add → SET|WEAKSET, clear → MAP|SET, has/delete →
// all). Guard misses return `undefined`, matching the pre-fix open-`$Object`
// fall-through (brand-check TypeError refinement is #2604-family follow-up).
//
// The standalone assertions instantiate with an EMPTY import object and first
// assert the module declares ZERO function imports — truly HOST-FREE.
//
// Representation caveat (pre-existing, NOT this fix): a miss result (`get` of
// an absent key) compares `== null` but not `=== undefined` standalone — the
// same holds for the TYPED `Map.get` miss and the open-`$Object` method-call
// bottom arm (the #2106-family undefined-vs-null rep gap). Tests assert the
// semantics the substrate actually guarantees (`== null` / truthiness /
// values), identical to the typed lane.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result: any = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

/** Compile host-free (`target: standalone`), assert 0 function imports, run. */
async function runStandaloneHostFree(source: string): Promise<unknown> {
  const result: any = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const mod = await WebAssembly.compile(result.binary);
  const fnImports = WebAssembly.Module.imports(mod).filter((i) => i.kind === "function");
  // The whole point of the fix: this dispatch is host-free. If a host bridge
  // import sneaks back in (env.WeakMap_* / env.Set_*), fail loudly.
  expect(fnImports.map((i) => `${i.module}.${i.name}`)).toEqual([]);
  const instance: any = await WebAssembly.instantiate(mod, {});
  return instance.exports.test();
}

describe("#3309 — standalone any-receiver Map/Set methods dispatch native (host-free)", () => {
  it("Map set/get/has round trip, string key (was env.WeakMap_* imports)", async () => {
    const src = `const m: any = new Map();
                 m.set("k", 42);
                 const g = m.get("k");
                 const h = m.has("k");
                 export function test(): number { return (g === 42 && h) ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("Map number keys hash consistently with the typed-lane boxing", async () => {
    const src = `const m: any = new Map();
                 m.set(1, 10); m.set(2, 20);
                 export function test(): number { return (m.get(2) === 20 && m.get(1) === 10) ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("Map.set is chainable (returns the receiver)", async () => {
    const src = `const m: any = new Map();
                 m.set(1, "a").set(2, "b");
                 export function test(): number { return m.get(2) === "b" ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("Map.delete returns true then false; get of a deleted key is nullish", async () => {
    const src = `const m: any = new Map();
                 m.set("k", 1);
                 const d1 = m.delete("k");
                 const d2 = m.delete("k");
                 export function test(): number { return (d1 && !d2 && m.get("k") == null) ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("Map.clear empties the map", async () => {
    const src = `const m: any = new Map();
                 m.set("a", 1);
                 m.clear();
                 export function test(): number { return m.has("a") ? 0 : 1; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("Set add (chainable) / has / delete (was env.Set_add import)", async () => {
    const src = `const s: any = new Set();
                 s.add(1).add(2);
                 const d = s.delete(1);
                 export function test(): number { return (d && !s.has(1) && s.has(2)) ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("null key round-trips (canonical null rep matches the typed lane)", async () => {
    const src = `const m: any = new Map();
                 m.set(null, 5);
                 export function test(): number { return (m.get(null) === 5 && m.has(null)) ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("WeakMap with object keys dispatches through the same $Map arm", async () => {
    const src = `const key: any = { a: 1 };
                 const wm: any = new WeakMap();
                 wm.set(key, 42);
                 export function test(): number { return wm.get(key) === 42 ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("kind guard: get on a Set / add on a Map answer undefined (standalone; host throws)", async () => {
    // Host mode throws "s.get is not a function" — the guard-miss `undefined`
    // matches the pre-fix open-$Object fall-through, not host semantics; the
    // TypeError refinement is tracked with the #2604-family brand checks.
    const src = `const s: any = new Set(); s.add(7);
                 const m: any = new Map();
                 export function test(): number { return (s.get(7) == null && m.add(1) == null) ? 1 : 0; }`;
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("kind guard: clear on a WeakMap is a nullish no-op (weak collections have no clear)", async () => {
    const src = `const key: any = { a: 1 };
                 const wm: any = new WeakMap();
                 wm.set(key, 1);
                 const c = wm.clear();
                 export function test(): number { return (c == null && wm.get(key) === 1) ? 1 : 0; }`;
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("a user closed-struct method named get/set/add still wins over the $Map arm", async () => {
    const src = `const o: any = { get(k: any): number { return 99; } };
                 export function test(): number { return o.get(1) === 99 ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("typed-receiver Map/Set lanes are untouched", async () => {
    // NOTE: the typed `m.get(k)` result is compared through an `any` binding —
    // the inline `m.get("k") === 7` form fails standalone on CLEAN main too
    // (pre-existing typed-lane anyref-comparison quirk, verified 2026-07-16;
    // unrelated to #3309, which only touches the any-receiver dispatch).
    const src = `const m = new Map<string, number>();
                 m.set("k", 7);
                 const g: any = m.get("k");
                 const s = new Set<number>();
                 s.add(3);
                 export function test(): number { return (g === 7 && s.has(3)) ? 1 : 0; }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });
});
