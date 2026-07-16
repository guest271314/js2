// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2571 — native CLASS generator methods in a no-JS-host target.
 *
 * Before this slice, a class generator method (`class C { *m(){ yield … } }`)
 * compiled to a module that VALIDATED but could not INSTANTIATE in standalone /
 * WASI: it imported the eager-buffer host runtime (`__gen_create_buffer`,
 * `__create_generator`, `__gen_next`, …), which has no pure-Wasm backing. A free
 * `function*` was already lowered by the native generator state machine
 * (#1665/#2170/#2171) with zero imports, but `MethodDeclaration` generators were
 * force-routed to the host path.
 *
 * This slice admits a class instance/static generator method into the native
 * state machine by threading the receiver `this` as a synthetic leading param
 * (the state struct already persists + rehydrates params), so a class method
 * generator lowers to a `$GenState_*` struct with no host imports.
 *
 * Asserts, for each shape: ZERO `__gen_*` / `__create_generator*` host imports,
 * the module instantiates with an EMPTY import object, and the values are
 * correct. Object-literal method generators + capturing / `arguments` / `super`
 * method generators are out of scope here and keep the host path (documented
 * follow-up) — covered by the "still host / unregressed" cases.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_GEN_RE = /^(__gen_|__create_generator|__create_async_generator)/;

async function compileNoHost(src: string): Promise<{ binary: Uint8Array; genImports: string[] }> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const genImports = WebAssembly.Module.imports(mod)
    .filter((i) => HOST_GEN_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  return { binary: r.binary, genImports };
}

async function runNative(src: string): Promise<number> {
  const { binary, genImports } = await compileNoHost(src);
  expect(genImports, "native class method generator must emit NO __gen_* host import").toEqual([]);
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2571 native class generator methods (no-JS-host target)", () => {
  it("class instance method generator: new C().m().next().value === 42, no host imports", async () => {
    const src = `class C { *m() { yield 42; } }
export function test(): number { return (new C().m().next().value as number); }`;
    expect(await runNative(src)).toBe(42);
  });

  it("instance method generator reading this: yields this.x", async () => {
    const src = `class C { x = 7; *m() { yield this.x; } }
export function test(): number { return (new C().m().next().value as number); }`;
    expect(await runNative(src)).toBe(7);
  });

  it("instance method generator with this AND a user param", async () => {
    const src = `class C { x = 10; *m(d: number) { yield this.x + d; } }
export function test(): number { return (new C().m(5).next().value as number); }`;
    expect(await runNative(src)).toBe(15);
  });

  it("static method generator: C.m() yields 1 then 2", async () => {
    const src = `class C { static *m() { yield 1; yield 2; } }
export function test(): number {
  const it = C.m();
  return (it.next().value as number) * 10 + (it.next().value as number);
}`;
    expect(await runNative(src)).toBe(12);
  });

  it("multiple yields stream in order through repeated .next()", async () => {
    const src = `class C { *m() { yield 1; yield 2; yield 3; } }
export function test(): number {
  const it = new C().m();
  return (it.next().value as number) * 100 + (it.next().value as number) * 10 + (it.next().value as number);
}`;
    expect(await runNative(src)).toBe(123);
  });

  it("done flag is set after the last yield", async () => {
    const src = `class C { *m() { yield 7; } }
export function test(): number {
  const it = new C().m();
  it.next();
  return it.next().done ? 1 : 0;
}`;
    expect(await runNative(src)).toBe(1);
  });

  it("lazy: the method-generator body does not run until the first .next()", async () => {
    const src = `let ran = 0;
class C { *m() { ran = 1; yield 1; } }
export function test(): number {
  const it = new C().m();
  const before = ran;
  it.next();
  return before * 10 + ran;
}`;
    // before === 0 (not yet run), after first next ran === 1 → 0*10 + 1 = 1
    expect(await runNative(src)).toBe(1);
  });

  it("free function* generator stays native (regression guard)", async () => {
    const src = `function* g() { yield 9; }
export function test(): number { return (g().next().value as number); }`;
    expect(await runNative(src)).toBe(9);
  });

  it("capturing class method generator lowers NATIVELY in standalone (#3032 W4 — was: bail to host)", async () => {
    // (#3032 W4) Reads `cap` captured from the enclosing function. Pre-W4 this
    // bailed to the eager host path (this test asserted the bail); the method
    // body resolves captures through the #2029/#3039 promotion machinery
    // (`ctx.capturedBoxGlobals`/`capturedGlobals` module globals), which is
    // fctx-independent — so the resume function compiles the same body with
    // the same global reads and the standalone lane routes native: zero host
    // imports AND the value reads back correctly (the eager path also ran the
    // body at creation, violating §27.5.3.1-3 suspend-at-start).
    const src = `function outer(): number {
  let cap = 3;
  class C { *m() { yield cap; } }
  return (new C().m().next().value as number);
}
export function test(): number { return outer(); }`;
    expect(await runNative(src)).toBe(3);
  });

  it("object-literal method generator now lowers natively (#2581 lifted the #2571 deferral)", async () => {
    // #2571 originally deferred object-literal method generators to the host
    // path; #2581 wired the literals.ts emit through the native factory (the
    // object-literal method body func also leads with a `this` struct param), so
    // they are native now too. Full coverage lives in
    // tests/issue-2581-objlit-method-generators.test.ts.
    const src = `export function test(): number {
  const o = { *m() { yield 9; } };
  return (o.m().next().value as number);
}`;
    expect(await runNative(src)).toBe(9);
  });
});
