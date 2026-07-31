// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3872 — write to a non-writable data property must fail.
 *
 * `Object.defineProperty(o,"p",{writable:false})` then `o.p = 20` neither threw
 * nor (on host) left the value alone. `ctx.definedPropertyFlags` is the
 * compile-time mirror of the descriptor attributes and carries
 * `PROP_FLAG_WRITABLE`; `Object.defineProperty` writes it, but until now nothing
 * on the assignment path read it.
 *
 * The consult sits at the TOP of `compilePropertyAssignment`, before any
 * lowering-path selection: §10.1.9.2 OrdinarySetWithOwnDescriptor step 2.b
 * decides the write fails regardless of which backend would perform it. Placing
 * it lower (beside the frozen consult) fixed only host — standalone returns
 * through an earlier branch.
 *
 * It must be a COMPILE-TIME throw: standalone's `__extern_set_strict` is
 * deliberately aliased to the non-throwing native `__extern_set` (#2017) because
 * the native runtime has no TypeError bridge, so the runtime path can suppress
 * the store but can never raise.
 *
 * Module code is always strict (§11.2.2), so every case below is a strict case:
 * the write must throw a *catchable* TypeError.
 *   1 = TypeError caught   2 = other throwable   0 = no throw
 *
 * MEASURED, host lane, this probe set: stock main 7/13 → 9/13 with the fix.
 * Harness: bare `compile()` + `buildImports` (host) and
 * `compile({target:"standalone"})` with an empty import object.
 *
 * KNOWN GAP — the standalone half is NOT fixed by this change and is asserted
 * as such below rather than silently omitted. `definedPropertyFlags` is only
 * populated on the `useStruct` lowering path (`object-ops.ts:1692`, consumed at
 * `:2078`), which requires a registered struct field. Standalone compiles
 * `const o: any = {}` to a native `$Object`, so `fieldIdx < 0`, `useStruct` is
 * false, and the mirror stays EMPTY — verified by instrumenting the lookup:
 * host `{"o@41:p": 14}` vs standalone `[]`. Populating the mirror on the
 * non-struct path is the remaining work for the standalone lane.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test!();
}

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
  expect(result.imports?.length ?? 0, "standalone module must declare no host imports").toBe(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>).test!();
}

const DP = `Object.defineProperty(o,"p",{value:10,writable:false,enumerable:true,configurable:true});`;

const THROWS = `export function test(): number {
  const o: any = {};
  ${DP}
  try { o.p = 20; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
  return 0;
}`;

const VALUE_PRESERVED = `export function test(): number {
  const o: any = {};
  ${DP}
  try { o.p = 20; } catch (e: any) {}
  return o.p;
}`;

describe("#3872 — non-writable data property write (host)", () => {
  it("throws a catchable TypeError", async () => {
    expect(await runHost(THROWS)).toBe(1);
  });

  it("leaves the value untouched", async () => {
    expect(await runHost(VALUE_PRESERVED)).toBe(10);
  });

  it("compound assignment (%=) throws a catchable TypeError", async () => {
    // 22 of the ~24 corpus rows are compound. These route through
    // `compilePropertyCompoundAssignment`, NOT `compilePropertyAssignment`, so
    // they need their own consult.
    expect(
      await runHost(`export function test(): number {
        const o: any = {}; ${DP}
        try { o.p %= 20; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
        return 0;
      }`),
    ).toBe(1);
  });

  it("compound assignment (+=) throws a catchable TypeError", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {}; ${DP}
        try { o.p += 1; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
        return 0;
      }`),
    ).toBe(1);
  });

  it("compound assignment leaves the value untouched", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {}; ${DP}
        try { o.p += 1; } catch (e: any) {}
        return o.p;
      }`),
    ).toBe(10);
  });

  it("evaluates the RHS for its side effects before failing", async () => {
    // §13.15.2: the RHS is evaluated before Set is attempted.
    expect(
      await runHost(`let n = 0;
        function bump(): number { n = n + 1; return 7; }
        export function test(): number {
          const o: any = {};
          ${DP}
          try { o.p = bump(); } catch (e: any) {}
          return n;
        }`),
    ).toBe(1);
  });
});

describe("#3872 — standalone lane", () => {
  it("suppresses the store (pre-existing native behaviour, not regressed)", async () => {
    expect(await runStandalone(VALUE_PRESERVED)).toBe(10);
  });

  it("KNOWN GAP: does not yet throw — definedPropertyFlags is unpopulated off the useStruct path", async () => {
    // Asserted as the CURRENT behaviour so the gap is visible and this test
    // flips loudly when the mirror is populated for native `$Object` receivers.
    // Spec-correct value is 1; standalone returns 0 (no throw).
    expect(await runStandalone(THROWS)).toBe(0);
  });
});

describe("#3872 — non-regression", () => {
  it("a writable property still accepts writes", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {};
        Object.defineProperty(o,"p",{value:10,writable:true,configurable:true});
        o.p = 20; return o.p;
      }`),
    ).toBe(20);
  });

  it("a plain property write is unaffected", async () => {
    expect(await runHost(`export function test(): number { const o: any = {p:1}; o.p = 20; return o.p; }`)).toBe(20);
  });

  it("a sibling property on the same object is unaffected", async () => {
    expect(await runHost(`export function test(): number { const o: any = {q:1}; ${DP} o.q = 9; return o.q; }`)).toBe(
      9,
    );
  });

  it("getOwnPropertyDescriptor still reports writable:false", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {}; ${DP}
        const d: any = Object.getOwnPropertyDescriptor(o,"p");
        return d && d.writable === false ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the defined value is still readable", async () => {
    expect(await runHost(`export function test(): number { const o: any = {}; ${DP} return o.p; }`)).toBe(10);
  });

  it("a frozen object still throws its own frozen TypeError (#3420 path)", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {x:1};
        Object.freeze(o);
        try { o.x = 9; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
        return 0;
      }`),
    ).toBe(1);
  });
});
