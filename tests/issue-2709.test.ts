// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2709 — SuperCall remaining sub-cases (carved out of #1551).
 *
 * Two areas are exercised here:
 *
 *  - Sub-case 2 (FIXED): uninitialized-`this` PutValue on a `super[key]`
 *    SuperProperty whose computed key contains a `super(...)` call —
 *    `super[super()] = 0`, `super[super()]++`, `++super[super()]`,
 *    `super[super()] += 1`. Per ECMA-262 §13.3.7.1 (Evaluation of
 *    SuperProperty) reference resolution performs `GetThisBinding()` FIRST
 *    (step 2), which throws a `ReferenceError` while `this` is uninitialized
 *    (a derived constructor before `super(...)` returns) — BEFORE the key
 *    Expression and the RHS. So the parent constructor (the inner `super()`)
 *    must NOT run. The compiler now emits that `ReferenceError` for this shape
 *    instead of silently building a broken instance (or trapping with an
 *    `illegal cast`).
 *
 *  - Sub-case 5 (regression guard): a top-level `super(f())` argument call
 *    that mutates a module global must have that mutation visible afterward
 *    (the "secondary quirk" from #1551 — already resolved by the #1551
 *    arg-rollback fix; guarded here so it cannot silently regress).
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

// ---------------------------------------------------------------------------
// Sub-case 2 — uninitialized-`this` PutValue / update on `super[super()]`.
// The probe distinguishes:
//   1   threw a ReferenceError BEFORE the parent constructor ran  (correct)
//   100 nothing thrown            (wrong: silently built an instance)
//   200 parent constructor ran    (wrong: super() evaluated before the throw)
//   3   threw, but not a ReferenceError (wrong error type)
// The parent's constructor sets `baseRan` then throws a NON-Error value, so a
// caught ReferenceError can only have come from the SuperProperty guard, never
// from the parent.
// ---------------------------------------------------------------------------
function uninitThisProbe(writeExpr: string): string {
  return `
    let baseRan = false;
    class Base { constructor() { baseRan = true; throw 999; } }
    class Derived extends Base {
      constructor() { ${writeExpr}; }
    }
    export function test(): number {
      let threw = false;
      let isRef = false;
      try { new Derived(); } catch (e) {
        threw = true;
        if (e instanceof ReferenceError) isRef = true;
      }
      if (!threw) return 100;
      if (baseRan) return 200;
      return isRef ? 1 : 3;
    }
  `;
}

describe("#2709 sub-case 2 — uninitialized-this SuperProperty PutValue throws ReferenceError", () => {
  it("super[super()] = 0 throws ReferenceError before the parent constructor runs", async () => {
    expect(await runReturnNumber(uninitThisProbe("super[super()] = 0"))).toBe(1);
  });

  it("super[super()]++ (postfix) throws ReferenceError before the parent constructor runs", async () => {
    expect(await runReturnNumber(uninitThisProbe("super[super()]++"))).toBe(1);
  });

  it("++super[super()] (prefix) throws ReferenceError before the parent constructor runs", async () => {
    expect(await runReturnNumber(uninitThisProbe("++super[super()]"))).toBe(1);
  });

  it("super[super()] += 1 (compound) throws ReferenceError before the parent constructor runs", async () => {
    expect(await runReturnNumber(uninitThisProbe("super[super()] += 1"))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression guard: a normal super-element write is UNAFFECTED. The guard only
// fires for a key that contains a super() call; an ordinary computed key must
// compile and run exactly as before.
// ---------------------------------------------------------------------------
describe("#2709 — ordinary element writes/updates are unaffected by the guard", () => {
  it("plain array element write/update still works", async () => {
    const src = `
      export function test(): number {
        const a = [10, 20];
        a[1] = 9;
        a[0]++;
        return a[0] + a[1]; // 11 + 9 = 20
      }
    `;
    expect(await runReturnNumber(src)).toBe(20);
  });

  it("a derived constructor that calls super() first builds a correct instance", async () => {
    const src = `
      class P { x: number = 0; constructor(x: number) { this.x = x; } }
      class C extends P { constructor() { super(5); } }
      export function test(): number { return new C().x; }
    `;
    expect(await runReturnNumber(src)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Sub-case 5 (regression guard) — top-level `super(f())` where `f` mutates a
// module global. The parent receives the returned value AND the global mutation
// is visible afterward (#1551 secondary quirk).
// ---------------------------------------------------------------------------
describe("#2709 sub-case 5 — top-level super-arg call mutates a visible module global", () => {
  it("super(f()) increments a module global exactly once and the parent receives 42", async () => {
    const src = `
      let calls = 0;
      let parentGot = -1;
      function f(): number { calls = calls + 1; return 42; }
      class P { v: number = 0; constructor(v: number) { this.v = v; parentGot = v; } }
      class C extends P { constructor() { super(f()); } }
      new C();
      export function test(): number {
        if (parentGot !== 42) return 1000 + parentGot; // parent must receive 42
        if (calls !== 1) return 2000 + calls;           // mutation must be visible
        return 7;
      }
    `;
    expect(await runReturnNumber(src)).toBe(7);
  });
});
