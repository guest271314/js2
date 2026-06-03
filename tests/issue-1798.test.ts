// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1798 — explicit `: any` return + `new C()` → Wasm validation failure.
 *
 *   function f(): any { return new C(); }
 *
 * The function signature correctly declares an `externref` result (TS `any` →
 * `externref`), but the IR front-end's return-tail (`lowerTail` in
 * `src/ir/from-ast.ts`) terminated with the constructor's struct ref
 * (`(ref $C)`) WITHOUT coercing it to `externref`. The module then failed Wasm
 * validation at instantiate time:
 *
 *   type error in return[0] (expected externref, got (ref null N))
 *
 * Fix: the IR return-tail now reconciles the lowered value with the declared
 * result type — reference-shaped values returned into an `any` (externref)
 * result are coerced via `extern.convert_any`; numeric values defer to the
 * legacy path (which boxes via `__box_number`). A defense-in-depth check in
 * `src/ir/verify.ts` demotes any future return/result-type mismatch to legacy
 * instead of emitting an invalid module.
 *
 * The inferred-return form (no annotation) always worked — included here as a
 * guard that the fix didn't perturb the matching-type path.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1798 — explicit any return of new C()", () => {
  it("compiles, instantiates, and the returned instance is usable", async () => {
    const exports = await compileToWasm(`
      class C { x: number = 5; constructor(v: number) { this.x = v; } }
      function make(v: number): any { return new C(v); }
      export function run(): number {
        const obj = make(42) as C;
        return obj.x;
      }
    `);
    expect((exports.run as () => number)()).toBe(42);
  });

  it("any-return of an object literal validates and is usable", async () => {
    const exports = await compileToWasm(`
      function makeObj(): any { return { a: 11, b: 22 }; }
      export function run(): number {
        const o = makeObj() as { a: number; b: number };
        return o.a + o.b;
      }
    `);
    expect((exports.run as () => number)()).toBe(33);
  });

  it("numeric any-return still works (legacy box path)", async () => {
    const exports = await compileToWasm(`
      export function f(): any { return 5; }
    `);
    // f returns a boxed number externref; reading it back through JS yields 5.
    expect((exports.f as () => unknown)()).toBe(5);
  });

  it("boolean any-return still works", async () => {
    const exports = await compileToWasm(`
      export function f(): any { return true; }
    `);
    expect((exports.f as () => unknown)()).toBe(true);
  });

  it("inferred class return type is unaffected", async () => {
    const exports = await compileToWasm(`
      class C { x: number = 7; }
      function make(): C { return new C(); }
      export function run(): number { return make().x; }
    `);
    expect((exports.run as () => number)()).toBe(7);
  });
});
