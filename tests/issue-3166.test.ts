// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3166 (S1) — computed-key INVOCATION of a class-instance field that holds a
// closure: `c[1+1]()` / `c[String(1+1)]()` where `[1+1] = () => …` is a class
// field.
//
// Root cause: for a computed-name class field, TypeScript does NOT track a
// member named "2", so the element-access callee (`c[1+1]`) carries no call
// signature and the generic closure-dispatch fallback never fired; and it is
// not a prototype method (no `ClassName_2` in funcMap), so the method-dispatch
// paths missed it too. The struct-field READ already canonicalises the key
// (numeric/string) to field "2" and returns the closure — only the INVOCATION
// was dropped (returned the missing-property default, 0).
//
// Fix (src/codegen/expressions/calls.ts): when an element-access call on a
// user-class-instance receiver matches no method, route the read + call through
// the same `ref.test`-guarded dynamic `call_ref` machinery an `any`-typed
// identifier call uses (`tryEmitInlineDynamicCall`). Covers both the static
// (`c[1+1]()`) and runtime (`c[String(1+1)]()`) key forms. A non-closure field
// value hits the safe default arm (historical `ref.null.extern`).
//
// Scope: S1 only — read-side canonicalisation + computed-key method dispatch on
// CLOSED class structs. Genuinely-runtime-key MEMBERS (`[f()] = 1` where the key
// is not const-foldable) still need the $props overflow substrate (S2) and are
// out of scope here.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "issue-3166.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const leaked = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(
    leaked.map((i) => i.name),
    "no host imports leaked in standalone",
  ).toEqual([]);
  const inst = await WebAssembly.instantiate(mod, {});
  return (inst.exports as { main(): number }).main();
}

describe("#3166 S1 — computed-key call of a class-instance field closure", () => {
  it("numeric computed key: c[1+1]() invokes the field closure", async () => {
    expect(
      await runStandalone(
        `class C { [1+1] = () => { return 2; }; } const c = new C(); export function main(): number { return c[1+1](); }`,
      ),
    ).toBe(2);
  });

  it("string-key of a numeric-named field: c[String(1+1)]() invokes", async () => {
    expect(
      await runStandalone(
        `class C { [1+1] = () => { return 2; }; } const c = new C(); export function main(): number { return c[String(1+1)](); }`,
      ),
    ).toBe(2);
  });

  it("computed-key method dispatch passes an argument", async () => {
    expect(
      await runStandalone(
        `class C { [1+1] = (x: number) => { return x + 1; }; } const c = new C(); export function main(): number { return c[1+1](40); }`,
      ),
    ).toBe(41);
  });

  it("static-key literal key of a named field still works (no regression)", async () => {
    expect(
      await runStandalone(
        `class C { g = () => { return 7; }; } const c = new C(); export function main(): number { return c["g"](); }`,
      ),
    ).toBe(7);
  });

  it("computed-key VALUE-field read still canonicalises (control)", async () => {
    expect(
      await runStandalone(
        `class C { [1+1] = 5; } const c = new C(); export function main(): number { return c[1+1] + c[String(1+1)]; }`,
      ),
    ).toBe(10);
  });

  it("full test262 fields-methods shape: instance asserts pass", async () => {
    expect(
      await runStandalone(
        `let C = class { [1 + 1] = () => { return 2; }; };
         let c = new C();
         export function main(): number {
           let ok = 1;
           if (c[1 + 1]() !== 2) ok = 0;
           if (c[String(1 + 1)]() !== 2) ok = 0;
           return ok;
         }`,
      ),
    ).toBe(1);
  });
});
