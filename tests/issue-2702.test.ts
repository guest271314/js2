// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2702 — `instanceof` spec correctness (ECMA-262 §13.10.2 InstanceofOperator +
// §7.3.20 OrdinaryHasInstance):
//   (a) a non-object / non-callable RHS throws a TypeError,
//   (b) the `Symbol.hasInstance` well-known method protocol is honored,
//   (c) OrdinaryHasInstance's V-not-an-object short-circuit precedes the
//       `prototype` read (so a primitive V never triggers a `prototype`
//       getter or the non-object-prototype TypeError).
//
// Each case is validated by `assertEquivalent`, which runs the compiled wasm
// AND native JS and asserts they agree — native JS implements the spec, so a
// match proves the wasm matches the spec.
import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#2702 instanceof spec correctness", () => {
  it("non-object RHS (a primitive) throws a TypeError", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          const r = (0 as any) instanceof (5 as any);
          return 99;
        } catch (e) {
          return (e instanceof TypeError) ? 1 : 0;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("non-object RHS (a string) throws a TypeError", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          const r = ({} as any) instanceof ("x" as any);
          return 99;
        } catch (e) {
          return (e instanceof TypeError) ? 1 : 0;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Symbol.hasInstance handler is invoked and its result is coerced (ToBoolean)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const F: any = {};
        F[Symbol.hasInstance] = function () { return true; };
        return ((0 as any) instanceof F) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Symbol.hasInstance returning a falsy value yields false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const F: any = {};
        F[Symbol.hasInstance] = function () { return 0; };
        return ((1 as any) instanceof F) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("a non-callable Symbol.hasInstance property throws a TypeError", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const F: any = {};
        F[Symbol.hasInstance] = null;
        try {
          const r = (0 as any) instanceof F;
          return 99;
        } catch (e) {
          return (e instanceof TypeError) ? 1 : 0;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("primitive V short-circuits to false before a non-object prototype throws (§7.3.20 step 3 < step 4)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const f: any = function () {};
        f.prototype = 5;
        // V is the primitive 0 → OrdinaryHasInstance returns false WITHOUT
        // reading f.prototype, so no TypeError despite the non-object prototype.
        return ((0 as any) instanceof f) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("regression: a class instance is still instanceof its class", async () => {
    await assertEquivalent(
      `
      class A {}
      class B extends A {}
      export function test(): number {
        const b = new B();
        let n = 0;
        if (b instanceof B) n += 1;
        if (b instanceof A) n += 2;
        return n;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("regression: a caught Error is still instanceof its error type", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw new TypeError("boom");
        } catch (e) {
          let n = 0;
          if (e instanceof TypeError) n += 1;
          if (e instanceof Error) n += 2;
          return n;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
