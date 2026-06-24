// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2638 — standalone `__to_primitive` CLASS-instance arm.
 *
 * A class instance is a *nominal* WasmGC struct — neither the dynamic `$Object`
 * runtime struct nor a `$Vec` array — so `__to_primitive`'s `ref.test`s missed
 * it and returned the struct unchanged; the caller's `__unbox_number(struct)`
 * then yielded NaN. This broke `(new C() as any) - 8`, `Number(new C() as any)`,
 * `(new C() as any) + 1`, etc. in standalone mode whenever the static class
 * type had been erased to externref.
 *
 * Fix: route a nominal class struct through the EXISTING per-struct
 * `__call_valueOf`/`__call_toString` dispatchers (§7.1.1.1 ordering) via the
 * reserved `__class_to_primitive` driver. No new coercion call-site, no host
 * import, standalone-only. The static `*`/`-`-on-a-typed-receiver path is
 * reduced at compile time and never enters this arm — guarded below.
 *
 * Scope note: the STRING-hint *consumer* paths (a class instance in a template
 * span / `String(new C() as any)`) are a SEPARATE pre-existing standalone
 * string-coercion gap (the `compileNativeTemplateExpression` / `String()`
 * lowering — `String(new C() as any)` does not even compile on origin/main),
 * NOT this numeric-arm fix. This test pins the valueOf/number-hint surface this
 * PR actually closes.
 *
 * Each case instantiates with an EMPTY import object — pure Wasm, no JS host.
 */

async function runSANum(src: string): Promise<number> {
  const res = await compile(src, { target: "standalone" });
  expect(res.imports.length).toBe(0); // host-free
  const inst = await WebAssembly.instantiate(res.binary, {});
  return (inst.instance.exports as { main(): number }).main();
}

describe("#2638 standalone __to_primitive over a CLASS instance", () => {
  it("reduces an any-typed class instance via valueOf through `-` (headline repro)", async () => {
    expect(
      await runSANum(`
        class C { valueOf(): number { return 50; } }
        function g(x: any): number { return x - 8; }
        export function main(): number { return g(new C()); }
      `),
    ).toBe(42);
  });

  it("reduces a class instance via valueOf through `Number(x as any)`", async () => {
    expect(
      await runSANum(`
        class C { valueOf(): number { return 42; } }
        export function main(): number { return Number(new C() as any); }
      `),
    ).toBe(42);
  });

  it("reduces a class instance via valueOf through `+` on an any operand", async () => {
    expect(
      await runSANum(`
        class C { valueOf(): number { return 40; } }
        function g(x: any): number { return x + 2; }
        export function main(): number { return g(new C()); }
      `),
    ).toBe(42);
  });

  it("number/default hint prefers valueOf over toString (§7.1.1.1 ordering)", async () => {
    // valueOf wins for a numeric consumer even when toString is also present.
    expect(
      await runSANum(`
        class C {
          valueOf(): number { return 42; }
          toString(): string { return "999"; }
        }
        export function main(): number { return Number(new C() as any); }
      `),
    ).toBe(42);
  });

  it("a class instance with NO valueOf/toString falls through unchanged (no crash)", async () => {
    // No user ToPrimitive → the driver returns the input unchanged → the
    // downstream numeric coerce yields NaN, exactly as pre-#2638. The point is
    // it must NOT trap.
    const got = await runSANum(`
      class C { x: number = 1; }
      function g(x: any): number { return x - 8; }
      export function main(): number { return Number.isNaN(g(new C())) ? 1 : 0; }
    `);
    expect(got).toBe(1);
  });

  it("static `*` on a typed receiver still reduces (never enters the new arm)", async () => {
    expect(
      await runSANum(`
        class C { valueOf(): number { return 21; } }
        function g(x: any): number { return x * 2; }
        export function main(): number { return g(new C()); }
      `),
    ).toBe(42);
  });

  it("no-regression: a `$Vec` array still reduces via Array.prototype.toString (#2358 #10)", async () => {
    expect(
      await runSANum(`
        export function main(): number { return Number([42] as any); }
      `),
    ).toBe(42);
  });

  it("no-regression: a dynamic `$Object` literal still reduces via valueOf", async () => {
    expect(
      await runSANum(`
        export function main(): number { return ({ valueOf: () => 42 } as any) - 0; }
      `),
    ).toBe(42);
  });
});
