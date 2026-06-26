// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1551 — SuperCall argument-list evaluation order + spread getter side-effects
 *
 * ECMA-262 §13.3.7.1 step 4: ArgumentListEvaluation must run left-to-right and
 * propagate abrupt completions before the parent constructor is invoked.
 *
 * Before this fix, `super(...)` argument expressions were only evaluated when a
 * parent field slot existed to receive them. For `class C extends Object` the
 * parent (Object) contributes zero recorded fields, so arg expressions were
 * dropped entirely — including any side effects or throws.
 *
 * The fix evaluates every argument expression unconditionally and drops the
 * resulting value when no parent field consumes it, preserving §13.3.7.1's
 * ordered-side-effect requirement.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runReturnNumber(src: string): Promise<number> {
  const r: any = await compile(src, { fileName: "test.ts" });
  if (!r.success) {
    const msg = r.errors.map((e: any) => e.message).join("\n");
    throw new Error(`compile failed:\n${msg}`);
  }
  const imports: any = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  return ((instance.exports as any).test as () => number)();
}

describe("#1551 SuperCall argument evaluation", () => {
  it("evaluates argument expressions at top-level of constructor (extends user class, no parent fields)", async () => {
    // Parent has no fields; the super argument expression must still be evaluated
    // for side effects per §13.3.7.1 step 4.
    const src = `
      let evaluated: boolean = false;
      function maker(): number { evaluated = true; return 0; }
      class P {}
      class C extends P {
        constructor() {
          super(maker());
        }
      }
      new C();
      export function test(): number { return evaluated ? 1 : 0; }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("evaluates trailing super(...) arguments even when parent has fewer fields", async () => {
    // P has 1 field; C passes 3 args. All three must be evaluated, only the
    // first stored into the parent slot.
    const src = `
      let count: number = 0;
      function bump(): number { count = count + 1; return count; }
      class P { x: number = 0; constructor(x: number) { this.x = x; } }
      class C extends P {
        constructor() { super(bump(), bump(), bump()); }
      }
      new C();
      export function test(): number { return count; }
    `;
    expect(await runReturnNumber(src)).toBe(3);
  });

  it("propagates abrupt completion (throw) from super arg eval at top-level of constructor", async () => {
    // thrower's exception must reach the user catch — no swallowing inside the
    // implicit super lowering wrapper.
    const src = `
      let evaluated: boolean = false;
      function thrower(): number { evaluated = true; throw {marker: 'thrown'}; }
      let caught: any = null;
      class P { x: number = 0; constructor(x: number) { this.x = x; } }
      class C extends P {
        constructor() {
          super(thrower());
        }
      }
      try { new C(); } catch (e) { caught = e; }
      export function test(): number {
        if (!evaluated) return 10;
        if (caught === null || caught === undefined) return 11;
        if ((caught as any).marker !== 'thrown') return 12;
        return 1;
      }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("evaluates super() args left-to-right (order preserved)", async () => {
    const src = `
      let seq: number = 0;
      function a(): number { seq = seq * 10 + 1; return 1; }
      function b(): number { seq = seq * 10 + 2; return 2; }
      function c(): number { seq = seq * 10 + 3; return 3; }
      class P {}
      class C extends P {
        constructor() { super(a(), b(), c()); }
      }
      new C();
      export function test(): number { return seq; }
    `;
    expect(await runReturnNumber(src)).toBe(123);
  });
});

// ---------------------------------------------------------------------------
// #1551 — `super(...)` nested inside control flow (try/if/loop) must NOT escape
// the enclosing try-region.
//
// Verified root cause (2026-06-26): the nested-super fallback in
// compileCallExpression (super inside control flow — the class-bodies inline
// handler never sees it) returned `null` after emitting the super-argument
// evaluation. The #1919 speculative wrapper in compileExpressionBody interprets
// a `null` inner result as "no usable value" and calls rollbackSpeculative,
// which TRUNCATED the just-emitted arg-evaluation instructions (including a
// throwing super-arg call) and replaced them with a default constant. So
// `super(thrower())` inside `try { } catch` never actually threw: the
// exception-raising call was deleted at compile time, the user's `catch` never
// ran, and execution fell through past `super(...)`. The fallback now returns
// VOID_RESULT (preserved by the wrapper) so ArgumentListEvaluation's side
// effects and abrupt completion survive (§13.3.7.1 step 4).
// ---------------------------------------------------------------------------
describe("#1551 super(...) inside try does not escape the try-region", () => {
  it("super(thrower()) inside try{}catch: the catch runs and past-super is NOT reached", async () => {
    // 0 PASS (catch ran, identity ok, reached 0); 1 escaped out of new C;
    // 2 catch never ran (reached set); 3 caught wrong identity
    const src = `
      let thrown = 777;
      let caught = -1;
      let reached = 0;
      class C extends Object {
        constructor() {
          try {
            super((() => { throw thrown; })());
            reached = 1;
          } catch (e) {
            caught = e as any;
          }
        }
      }
      export function test(): number {
        try { new C(); } catch (e) { return 1; }
        if (reached === 1) return 2;
        if (caught !== thrown) return 3;
        return 0;
      }
    `;
    expect(await runReturnNumber(src)).toBe(0);
  });

  it("super(thrower()) with a named-function arg inside try: catch runs, exception identity preserved", async () => {
    const src = `
      let caught = -1; let reached = 0;
      function thrower(): number { throw 777; }
      class C extends Object {
        constructor() {
          try { super(thrower()); reached = 1; } catch (e) { caught = e as any; }
        }
      }
      export function test(): number {
        try { new C(); } catch (e) { return 1; }
        if (reached === 1) return 2;
        return caught === 777 ? 0 : 3;
      }
    `;
    expect(await runReturnNumber(src)).toBe(0);
  });

  it("a NON-throwing super arg inside try is still evaluated (side effect persists)", async () => {
    const src = `
      let ran = 0;
      function f(): number { ran = 1; return 5; }
      class C extends Object {
        constructor() { try { super(f()); } catch (e) {} }
      }
      export function test(): number { new C(); return ran; }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("super(thrower()) with NO surrounding try still throws OUT of new C (no regression)", async () => {
    // 0 = threw out & reached stayed 0; 1 = no throw; 2 = threw but reached set
    const src = `
      let reached = 0;
      class C extends Object {
        constructor() { super((() => { throw 9; })()); reached = 1; }
      }
      export function test(): number {
        try { new C(); } catch (e) { return reached === 0 ? 0 : 2; }
        return 1;
      }
    `;
    expect(await runReturnNumber(src)).toBe(0);
  });

  it("plain ctor try/catch with no super still catches (baseline, unaffected)", async () => {
    const src = `
      let caught = -1;
      class C {
        constructor() {
          try { throw 55; } catch (e) { caught = e as any; }
        }
      }
      export function test(): number { new C(); return caught === 55 ? 0 : 1; }
    `;
    expect(await runReturnNumber(src)).toBe(0);
  });

  it("multi-arg super: left-to-right eval order + abrupt at 2nd arg propagates to catch", async () => {
    // order accumulates which args ran (a -> 1, bThrow -> 2): want 12; caught want 99
    const src = `
      let order = 0; let caught = -1;
      function a(): number { order = order * 10 + 1; return 1; }
      function bThrow(): number { order = order * 10 + 2; throw 99; }
      class C extends Object {
        constructor() { try { super(a(), bThrow()); } catch (e) { caught = e as any; } }
      }
      export function test(): number {
        new C();
        return order === 12 && caught === 99 ? 0 : 1;
      }
    `;
    expect(await runReturnNumber(src)).toBe(0);
  });

  it("super inside an if-branch evaluates its arg (nested non-try control flow)", async () => {
    const src = `
      let ran = 0;
      function g(): number { ran = ran + 1; return 7; }
      class C extends Object {
        constructor(b: boolean) { if (b) { super(g()); } else { super(0); } }
      }
      export function test(): number { new C(true); return ran; }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("super inside a nested try re-thrown to the outer catch", async () => {
    // inner catch sets 1 + rethrows; outer catch adds 10 => 11
    const src = `
      let caught = 0;
      function t(): number { throw 5; }
      class C extends Object {
        constructor() {
          try {
            try { super(t()); } catch (e) { caught = 1; throw e; }
          } catch (e2) { caught = caught + 10; }
        }
      }
      export function test(): number { new C(); return caught; }
    `;
    expect(await runReturnNumber(src)).toBe(11);
  });
});
