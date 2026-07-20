// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3468 C-core — closure-own-property side table (`--target standalone`).
 *
 * Function objects (closures) are WasmGC structs, not `$Object`s, so
 * `__extern_set`/`__extern_get`/`__extern_method_call` all fell through their
 * "not a `$Object`" arm for a closure receiver — dropping own-property writes,
 * reading them back as undefined, and returning undefined from a method call.
 * That is why the test262 `assert` harness (whose `sameValue`/`throws`/
 * `_isSameValue` are own properties of a `function assert(){}`) never fired
 * under standalone → vacuous passes.
 *
 * C-core gives those three arms a runtime, closure-identity-keyed side table
 * (`src/codegen/closure-props.ts`): each property-carrying closure gets a fresh
 * `$Object` "bag" reached by `ref.eq` on the closure identity, reusing the
 * existing `$Object` prop machinery.
 *
 * This PR deliberately lands the first runtime slice for CAPTURING closures,
 * verified through the DYNAMIC member path (a receiver via an `any`-typed
 * local). Capturing closures have their own concrete struct subtypes, so the
 * runtime can enable them without also enabling shared noncapturing wrappers.
 * Routing the noncapturing top-level test262 `function assert(){}` harness into
 * the substrate is a separate rollout: its merge-group measurement correctly
 * exposed thousands of pre-existing assertion failures and cannot land without
 * fixing those semantics or an explicitly approved oracle transition.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<{ ret: unknown; threw: boolean; err?: string }> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-3468.ts",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // Property writes can run either during module initialization or from the
  // exported test function, so keep instantiation and invocation in one catch.
  try {
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const fn = (instance.exports.test ?? instance.exports.main) as ((...a: unknown[]) => unknown) | undefined;
    return { ret: fn?.(), threw: false };
  } catch (e) {
    return { ret: undefined, threw: true, err: String((e as Error)?.message ?? e) };
  }
}

describe("#3468 C-core — closure own-property side table (dynamic path, verified)", () => {
  it("round-trips an own property written+read on a function value", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        let seed = 1;
        const memo = () => seed;
        const g = memo;
        (g as any).cache = 5;
        return (g as any).cache;
      }
    `);
    expect(ret).toBe(5);
  });

  it("invokes a method stored on a function value (distinctive 777 sentinel, not falsy)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        let seed = 1;
        const f = () => seed;
        const g = f;
        (g as any).m = () => 777;
        return (g as any).m();
      }
    `);
    expect(ret).toBe(777);
  });

  it("runs the method body's side effects (a global written inside the method sticks)", async () => {
    const { ret } = await runStandalone(`
      let flag = 0;
      export function test(): number {
        let seed = 1;
        const f = () => seed;
        const g = f;
        (g as any).setter = () => { flag = 9; return 0; };
        (g as any).setter();
        return flag;
      }
    `);
    expect(ret).toBe(9);
  });

  it("keys the side table on closure identity: write via g, read via the same closure", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        let seed = 1;
        const fn = () => seed;
        const g = fn;
        (g as any).x = 5;
        return (fn as any).x;
      }
    `);
    expect(ret).toBe(5);
  });

  it("keeps distinct closures' own properties isolated (no cross-talk)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        let aSeed = 1, bSeed = 2;
        const a = () => aSeed;
        const b = () => bSeed;
        const ga = a, gb = b;
        (ga as any).v = 11;
        (gb as any).v = 22;
        return (ga as any).v;
      }
    `);
    expect(ret).toBe(11);
  });

  it("does not let a custom own property shadow the builtin metadata path", async () => {
    // A user closure's `.length` is a pre-existing 0 via the any-path (its meta
    // is not populated); the point here is that writing a custom prop must NOT
    // change that — i.e. the side table doesn't shadow the builtin-meta arm.
    const { ret } = await runStandalone(`
      export function test(): number {
        let seed = 1;
        const fn = (x, y) => seed + x + y;
        const g = fn;
        (g as any).mine = 99;
        return (g as any).length;
      }
    `);
    expect(ret).toBe(0);
  });

  it("leaves shared noncapturing wrapper structs outside this rollout", async () => {
    const { ret } = await runStandalone(`
      export function test() {
        const fn = () => 1;
        const g = fn;
        (g as any).mine = 99;
        return (g as any).mine === 99 ? 1 : 0;
      }
    `);
    expect(ret).toBe(0);
  });
});
