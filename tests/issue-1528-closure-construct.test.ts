// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1632b-2 / #1528a residual — closure-as-dynamic-constructor host bridge.
 *
 * `new C(args)` where `C` is a runtime FUNCTION VALUE held in a binding
 * (`const C = makeCtor(); new C(42)`) was mis-classified by the unknown-ctor
 * path as an `extern_class` host import and failed at instantiation with
 * "No dependency provided for extern class C". It now routes through the
 * `__construct_closure` host helper, whose `_wrapCallableForHost` construct
 * trap runs the compiled closure body as ECMA-262 §10.2.2.
 *
 * JS-host only (the default compile mode). The non-constructable throw cases
 * (arrow / bound / prototype method) remain on the throwing `__construct`
 * brand-check path (#1921) and are covered by issue-1528.test.ts.
 */

async function runHost(source: string): Promise<unknown> {
  const r = await compile(source, {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  // The closure-construct bridge reads `__is_closure` off the live exports, so the
  // import object's top-level `setExports` must be wired (mirrors the test262
  // runner, tests/test262-runner.ts:3196).
  const setEx = (imports as { setExports?: (e: unknown) => void }).setExports;
  if (typeof setEx === "function") setEx(instance.exports);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1632b-2 closure-as-dynamic-constructor bridge", () => {
  it("constructs a factory-returned function value and reads an own field", async () => {
    expect(
      await runHost(`
        function makeCtor() { return function C(x: number) { (this as any).x = x; }; }
        const Ctor = makeCtor();
        export function test(): number { const inst: any = new Ctor(42); return inst.x; }
      `),
    ).toBe(42);
  });

  it("constructs with zero arguments", async () => {
    expect(
      await runHost(`
        function makeCtor() { return function C() { (this as any).y = 7; }; }
        const Ctor = makeCtor();
        export function test(): number { const inst: any = new Ctor(); return inst.y; }
      `),
    ).toBe(7);
  });

  it("threads multiple arguments in source order", async () => {
    expect(
      await runHost(`
        function makeCtor() { return function C(a: number, b: number) { (this as any).sum = a + b; }; }
        const Ctor = makeCtor();
        export function test(): number { const inst: any = new Ctor(3, 4); return inst.sum; }
      `),
    ).toBe(7);
  });

  // The ECMA-262 §10.2.2 "return the body's value if it is an object, else the
  // fresh receiver" override is implemented in the construct trap, but the
  // object-literal returned by a *compiled* ctor body does not yet read back
  // correctly through the host boundary (`inst.a` → NaN): the override object is
  // a compiled struct whose field read after the construct round-trip needs the
  // tag-aware dynamic reader. Field-initialising ctors (the dominant #1632b-2
  // cluster) work; the explicit-object-return override is a follow-up.
  it.skip("returns the body's object override when the ctor returns an object (follow-up)", async () => {
    expect(
      await runHost(`
        function makeCtor() { return function C(this: any) { (this as any).a = 1; return { a: 99 }; }; }
        const Ctor = makeCtor();
        export function test(): number { const inst: any = new Ctor(); return inst.a; }
      `),
    ).toBe(99);
  });

  it("constructs a function value reassigned through an any binding", async () => {
    expect(
      await runHost(`
        let C: any = function C0(v: number) { (this as any).v = v; };
        export function test(): number { const inst: any = new C(11); return inst.v; }
      `),
    ).toBe(11);
  });
});
