// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2545 — nested destructuring-param default value flow.
//
// `method({ w: { x, y, z } = {…} } = { w: {…} })`: when the OUTER parameter
// default object fires (the method is called with no argument), the nested
// object pattern must destructure the outer-default object's `w` property into
// `x`/`y`/`z` — previously these read 0/undefined (the whole nested-pattern
// destructuring yielded sentinels). #2544 (the struct.new field-pad arity fix)
// resolved both the invalid-Wasm CE and this value flow together; this file is
// the regression guard for the VALUE flow so it can't silently regress.
//
// Scope: HOST mode (matches the `meth-…-dflt-obj-ptrn-prop-obj` test262 family,
// which runs host — 48/48 sync variants pass). Standalone nested-default object
// params are a separate, pre-existing gap (a single-level standalone object
// default works, but the two-level nested default returns 0) tracked as a
// follow-on; not in #2545's scope.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2545 — nested destructuring-param default value flow [host]", () => {
  it("outer default fires → inner fields read the outer default object's values", async () => {
    // Called with no arg → outer default { w: { x: 1, y: 2, z: 3 } } fires.
    // The inner pattern destructures w into x/y/z (NOT the inner default).
    expect(
      await run(
        `class C {
           method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 3 } }): number {
             return x * 100 + y * 10 + z;
           }
         }
         export function test(): number { return new C().method(); }`,
      ),
    ).toBe(123);
  });

  it("returns z (last field) from the outer default object", async () => {
    expect(
      await run(
        `class C {
           method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 9 } }): number { return z; }
         }
         export function test(): number { return new C().method(); }`,
      ),
    ).toBe(9);
  });

  it("inner-pattern default fires when w is undefined (the already-passing path)", async () => {
    // Called with { w: undefined } → w's value is undefined → the INNER pattern
    // default { x: 4, y: 5, z: 6 } fires. Contrast path; must stay correct.
    expect(
      await run(
        `class C {
           method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 3 } }): number {
             return x * 100 + y * 10 + z;
           }
         }
         export function test(): number { return new C().method({ w: undefined } as any); }`,
      ),
    ).toBe(456);
  });

  it("explicit argument overrides both defaults", async () => {
    expect(
      await run(
        `class C {
           method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 3 } }): number {
             return x * 100 + y * 10 + z;
           }
         }
         export function test(): number { return new C().method({ w: { x: 7, y: 8, z: 9 } } as any); }`,
      ),
    ).toBe(789);
  });

  it("static method: outer default fires", async () => {
    expect(
      await run(
        `class C {
           static method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 3 } }): number {
             return x * 100 + y * 10 + z;
           }
         }
         export function test(): number { return C.method(); }`,
      ),
    ).toBe(123);
  });
});
