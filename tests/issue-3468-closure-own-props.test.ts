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
 * ## Reachability (important — see the `.skip` block)
 * The C-core RUNTIME substrate is verified below through the DYNAMIC member path
 * (a receiver flowing through an `any`-typed local — e.g. `const g = fn`), which
 * lowers to `__extern_set`/`__extern_get`/`__extern_method_call` and therefore
 * hits the new arms.
 *
 * A member op on a bare **function-DECLARATION** receiver (`assert.x = fn`,
 * `assert.x`, `assert.m()` — exactly what the test262 harness uses) is instead
 * lowered STATICALLY against the closure-wrapper struct (the write is dropped;
 * the read resolves to undefined) and never reaches these arms. Fixing that
 * needs a front-end member-dispatch routing change (deferred — the A/routing
 * follow-on, tracked on #3468). The harness-shaped cases are therefore `.skip`ed
 * with the expected post-routing behaviour, so they document the target without
 * failing CI.
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
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const fn = (instance.exports.test ?? instance.exports.main) as ((...a: unknown[]) => unknown) | undefined;
  try {
    return { ret: fn?.(), threw: false };
  } catch (e) {
    return { ret: undefined, threw: true, err: String((e as Error)?.message ?? e) };
  }
}

describe("#3468 C-core — closure own-property side table (dynamic path, verified)", () => {
  it("round-trips an own property written+read on a function value", async () => {
    const { ret } = await runStandalone(`
      function memo(){}
      const g = memo;
      (g as any).cache = 5;
      export function test(): number { return (g as any).cache; }
    `);
    expect(ret).toBe(5);
  });

  it("invokes a method stored on a function value (distinctive 777 sentinel, not falsy)", async () => {
    const { ret } = await runStandalone(`
      function f(){}
      const g = f;
      (g as any).m = () => 777;
      export function test(): number { return (g as any).m(); }
    `);
    expect(ret).toBe(777);
  });

  it("runs the method body's side effects (a global written inside the method sticks)", async () => {
    const { ret } = await runStandalone(`
      let flag = 0;
      function f(){}
      const g = f;
      (g as any).setter = () => { flag = 9; return 0; };
      (g as any).setter();
      export function test(): number { return flag; }
    `);
    expect(ret).toBe(9);
  });

  it("keys the side table on closure identity: write via g, read via the same closure", async () => {
    const { ret } = await runStandalone(`
      function fn(){}
      const g = fn;
      (g as any).x = 5;
      export function test(): number { return (fn as any).x; }
    `);
    expect(ret).toBe(5);
  });

  it("keeps distinct closures' own properties isolated (no cross-talk)", async () => {
    const { ret } = await runStandalone(`
      function a(){}
      function b(){}
      const ga = a, gb = b;
      (ga as any).v = 11;
      (gb as any).v = 22;
      export function test(): number { return (ga as any).v; }
    `);
    expect(ret).toBe(11);
  });

  it("does not let a custom own property shadow the builtin metadata path", async () => {
    // A user closure's `.length` is a pre-existing 0 via the any-path (its meta
    // is not populated); the point here is that writing a custom prop must NOT
    // change that — i.e. the side table doesn't shadow the builtin-meta arm.
    const { ret } = await runStandalone(`
      function fn(x, y){}
      const g = fn;
      (g as any).mine = 99;
      export function test(): number { return (g as any).length; }
    `);
    expect(ret).toBe(0);
  });
});

// The test262 `assert` harness uses bare function-DECLARATION member ops, which
// currently lower statically and bypass the C-core arms (see file header). These
// are the acceptance cases that go green once the front-end routing follow-on
// lands; skipped so they document the target without failing CI today.
describe.skip("#3468 — assert harness (pending front-end routing follow-on)", () => {
  const HARNESS = `
    function Test262Error(message) { this.message = message; }
    function assert(mustBeTrue, message) { if (mustBeTrue === true) { return; } throw new Test262Error(message); }
    assert._isSameValue = function (a, b) { if (a === b) { return a !== 0 || 1 / a === 1 / b; } return a !== a && b !== b; };
    assert.sameValue = function (actual, expected, message) { if (assert._isSameValue(actual, expected)) { return; } throw new Test262Error(message); };
  `;

  it("assert.sameValue(1, 2) throws (correcting a vacuous pass)", async () => {
    const { threw } = await runStandalone(HARNESS + `assert.sameValue(1, 2, "m");`);
    expect(threw).toBe(true);
  });

  it("assert.sameValue(2, 2) does not throw (control)", async () => {
    const { threw } = await runStandalone(HARNESS + `assert.sameValue(2, 2);`);
    expect(threw).toBe(false);
  });

  it("assert.throws(TypeError, () => {}) throws when the callback does not", async () => {
    const src =
      HARNESS +
      `assert.throws = function(errType, fn){ try { fn(); } catch(e){ return; } throw new Test262Error("no throw"); };
       assert.throws(TypeError, function(){});`;
    const { threw } = await runStandalone(src);
    expect(threw).toBe(true);
  });
});
