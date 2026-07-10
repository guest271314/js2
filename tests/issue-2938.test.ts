// #2938 — native generator result `.done` must carry the #2030/#2785 boolean
// BRAND through EVERY read path, so it boxes as $BoxedBoolean (not
// $BoxedNumber) when it crosses into an `any` context. Two erasure sites fixed:
//
//   1. generators-native.ts `tryCompileNativeGeneratorResultProperty` — the
//      typed and open `.done` read arms returned an unbranded `{kind:"i32"}`
//      (fixed on this branch's WIP commit; flips the test262 statement-form
//      repros language/statements/generators/{no-yield,return}.js).
//   2. property-access.ts Phase-3 consumer-side narrowing (#1269) — the
//      dynamic any-receiver read (`const d: any = g.next().done`) narrowed the
//      multi-struct dispatch result to a FRESH `{kind:"i32"}`, erasing the
//      brand carried by the candidates' struct field defs, and returned another
//      fresh `{kind:"i32"}` to the caller. The value then re-boxed via
//      `__box_number` → $BoxedNumber(1); the any-`===` typeof partition saw
//      number-vs-boolean, fell to ref identity, and `d === true` answered
//      false (the test262 harness shape `assert.sameValue(g.next().done, true)`
//      failed on every native generator).
//
// Native generators are standalone/wasi-only, but the Phase-3 narrowing fix
// applies wherever ALL dispatch candidates are boolean-branded — a genuine fix
// (never a widening) in both lanes: a branded read that previously boxed as a
// number now boxes as the boolean it statically is.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const envImports = r.imports.filter((i) => i.module === "env");
  expect(envImports, `unexpected env imports: ${envImports.map((i) => i.name).join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

// The dynamic (any-local) harness shape — the brand must survive the Phase-3
// narrowed dispatch read AND the local store.
const dynDone = (body: string): string => `export function test(): number {
  function* foo(): any {}
  const g: any = foo();
  const d: any = g.next().done;
  ${body}
}`;

describe("#2938 native gen-result .done is a BOOLEAN through the dynamic any path", () => {
  it("done-from-start: d === true (any local)", async () => {
    expect(await runStandalone(dynDone(`return d === true ? 1 : 2;`))).toBe(1);
  });

  it("done-from-start: d !== 1 (number 1 is NOT true)", async () => {
    expect(await runStandalone(dynDone(`return d === 1 ? 1 : 2;`))).toBe(2);
  });

  it("typeof d is boolean, not number", async () => {
    expect(await runStandalone(dynDone(`return typeof d === "boolean" ? 1 : 2;`))).toBe(1);
  });

  it("harness shape: sameValue(g.next().done, true) through any,any params", async () => {
    const src = `function same(a: any, b: any): number { return a === b ? 1 : 2; }
    export function test(): number {
      function* foo(): any {}
      const g: any = foo();
      return same(g.next().done, true);
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("with-yield first result: done === false (branded false)", async () => {
    const src = `export function test(): number {
      function* foo(): any { yield 42; }
      const g: any = foo();
      const d: any = g.next().done;
      return d === false ? 1 : 2;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("with-yield exhausted: done flips to true (branded)", async () => {
    const src = `export function test(): number {
      function* foo(): any { yield 42; }
      const g: any = foo();
      g.next();
      const d: any = g.next().done;
      return d === true ? 1 : 2;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("typed direct read stays correct: g.next().done === true", async () => {
    const src = `export function test(): number {
      function* foo(): any {}
      const g: any = foo();
      return g.next().done === true ? 1 : 2;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("statement-form repro shape (typed result local): result.done === true", async () => {
    // Mirrors test262 language/statements/generators/{no-yield,return}.js —
    // the checker-typed IteratorResult path (erasure site 1).
    const src = `export function test(): number {
      function* g() {}
      var result: any = g().next();
      return result.done === true ? 1 : 2;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });
});
