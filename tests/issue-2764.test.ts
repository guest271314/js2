// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2764 — a custom `@@hasInstance` (Symbol.hasInstance) handler must be invoked
// at the spec-mandated arity of EXACTLY ONE argument (ECMA-262 §13.10.2 step 4a:
// `Return ToBoolean(Call(instOfHandler, C, «O»))`). The runtime bridge
// (`_instanceofResult` in src/runtime.ts) previously dispatched the handler
// through the method bridge at its *max* arity (=4), so `arguments.length` was
// 4 inside the handler instead of 1. The fix re-bridges the recovered raw
// closure at known arity 1 (→ `__call_fn_method_1` → `__argc === 1`).
//
// Each case is validated by `assertEquivalent`, which runs the compiled wasm AND
// native JS and asserts they agree — native JS implements the spec, so a match
// proves the wasm matches the spec.
import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#2764 @@hasInstance handler arity", () => {
  it("handler sees arguments.length === 1 (not the bridge's max arity)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const F: any = {};
        let argc = -1;
        F[Symbol.hasInstance] = function () {
          argc = arguments.length;
          return false;
        };
        const _ = (0 as any) instanceof F;
        return argc;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("handler receives V as its sole argument (args[0] === V)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const F: any = {};
        let first = -1;
        F[Symbol.hasInstance] = function () {
          first = arguments[0];
          return false;
        };
        const _ = (42 as any) instanceof F;
        return first;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("handler `this` is the original receiver F and callCount === 1", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const F: any = {};
        let callCount = 0;
        let thisIsF = 0;
        F[Symbol.hasInstance] = function () {
          callCount += 1;
          thisIsF = (this === F) ? 1 : 0;
          return false;
        };
        const _ = (0 as any) instanceof F;
        return callCount * 10 + thisIsF;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("named-parameter handler still binds its one declared param to V", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const F: any = {};
        let seen = -1;
        let argc = -1;
        F[Symbol.hasInstance] = function (v: any) {
          seen = v;
          argc = arguments.length;
          return false;
        };
        const _ = (7 as any) instanceof F;
        return seen * 100 + argc;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("regression: handler result is still ToBoolean-coerced (truthy → true)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const F: any = {};
        F[Symbol.hasInstance] = function () { return 5; };
        return ((0 as any) instanceof F) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
