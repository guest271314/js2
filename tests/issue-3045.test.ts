// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3045 (partial) — a class-EXPRESSION binding (`const/var C = class { ... }`)
// must hold the constructor-object VALUE, so reading `C` as an rvalue works.
//
// Before this fix, `src/codegen/statements/variables.ts` SKIPPED the
// class-expression initializer ("already handled as class declaration"), so the
// (pre-hoisted, instance-struct-typed) local `$C` was declared but never stored.
// Reading `C` as a value then read an uninitialized null local, and coercing
// that null to externref for a host import threw
// `TypeError: Reflect.has called on non-object` /
// `Cannot convert undefined or null to object`. The fix routes class-expression
// initializers through the same "compile initializer → re-type the slot → store"
// path already used for arrow / function-expression bindings.
//
// NOTE: the private-method conformance tests this was harvested from (#3045's 8
// files) ALSO require a *separate, deeper* fix — class-expression method /
// constructor bodies do not capture the enclosing function's scope the way class
// *declarations* do (tied to the #779a captured-global machinery). That work is
// tracked separately; this file covers only the value-materialization fix.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<number> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.binary || r.binary.length === 0) {
    throw new Error("compile failed: " + (r.errors ?? []).map((e) => e.message).join("; "));
  }
  const { instance } = await WebAssembly.instantiate(r.binary, buildImports(r.imports, undefined, r.stringPool));
  return (instance.exports.test as () => number)();
}

describe("#3045 — class-expression binding holds the constructor value", () => {
  it("Reflect.has on a class-expression value does not trap (returns false for a missing key)", async () => {
    // Was: TypeError: Reflect.has called on non-object.
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { m() { return 1; } }; return Reflect.has(C, "x") ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("hasOwnProperty.call on a class-expression value does not trap", async () => {
    // Was: TypeError: Cannot convert undefined or null to object.
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { m() { return 1; } }; return Object.prototype.hasOwnProperty.call(C, "x") ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("class-expression value passed to a user function is a real object", async () => {
    expect(
      await compileAndRun(
        `function isObj(x: any): number { return (typeof x === "object" || typeof x === "function") ? 1 : 0; } export function test(): number { const C = class { m() { return 1; } }; return isObj(C); }`,
      ),
    ).toBe(1);
  });

  it("var form (test262 harness shape) also materializes the value", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { var C = class { #m() { return 1; } }; return Reflect.has(C, "x") ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("named class expression value is materialized", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const C = class D { m() { return 1; } }; return Reflect.has(C, "x") ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  // Regression guards: construction / methods / statics still work after routing
  // class expressions through the value-store path.
  it("new C() on a class expression still constructs and runs methods", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { v: number = 0; constructor(x: number) { this.v = x * 2; } m() { return this.v; } }; return new C(5).m(); }`,
      ),
    ).toBe(10);
  });

  it("two instances of a class-expression class are independent", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { v: number; constructor(x: number) { this.v = x; } }; return new C(3).v + new C(4).v; }`,
      ),
    ).toBe(7);
  });

  it("static member of a class expression is readable", async () => {
    expect(
      await compileAndRun(`export function test(): number { const C = class { static s: number = 9; }; return C.s; }`),
    ).toBe(9);
  });

  it("class-expression instance passed between functions preserves fields", async () => {
    expect(
      await compileAndRun(
        `function f(x: any): number { return x.v; } export function test(): number { const C = class { v: number = 8; }; return f(new C()); }`,
      ),
    ).toBe(8);
  });
});
