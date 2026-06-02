// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1553c — route the externref object *declaration* destructuring path
 * through the shared `destructureParamObject` helper (decl-mode).
 *
 * The legacy twin `compileExternrefObjectDestructuringDecl` had drifted from
 * the function-parameter helper: it lacked the struct fast path for
 * struct-typed nested defaults (root-cause 2), dropped initializers when the
 * binding target was itself a pattern (root-cause 1), and did not gate each
 * nested-pattern recursion behind a null/undefined guard (root-cause 4),
 * silently producing `undefined` instead of throwing TypeError for nested
 * null. Delegating to `destructureParamObject` fixes all three because that
 * path is the one already exercised by function-parameter destructuring of
 * the same externref RHS shapes.
 *
 * Spec basis: ECMA-262 §13.15.5.6 KeyedBindingInitialization /
 * §14.3.3.3 BindingInitialization — defaults fire only on `undefined`
 * (not `null`); destructuring a nullish value through a non-empty nested
 * pattern throws TypeError (RequireObjectCoercible).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1553c — externref decl destructuring via shared helper", () => {
  it("nested default fires on undefined prop (struct-typed default)", async () => {
    // root-cause 2: `{x:1,y:2,z:3}` default compiles to a known struct; the
    // decl twin used to extern.convert_any-roundtrip + __extern_get, which
    // returned undefined for every field. The helper takes the struct fast
    // path (ref.test + struct.get).
    const exports = await compileToWasm(`
      export function f(): number {
        let { w: { x, y, z } = { x: 1, y: 2, z: 3 } } = ({ w: undefined } as any);
        return x + y + z;
      }
    `);
    expect(exports.f()).toBe(6);
  });

  it("nested null throws TypeError (does NOT fire default, does NOT silently undefined)", async () => {
    // root-cause 4: `{w:null}` — null does not trigger the default, and
    // destructuring null through `{x}` must throw TypeError.
    const exports = await compileToWasm(`
      export function f(): number {
        try {
          let { w: { x } } = ({ w: null } as any);
          return x;
        } catch {
          return 99;
        }
      }
    `);
    expect(exports.f()).toBe(99);
  });

  it("nested undefined fires the nested default", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let { w: { x } = { x: 42 } } = ({ w: undefined } as any);
        return x;
      }
    `);
    expect(exports.f()).toBe(42);
  });

  it("top-level identifier default fires for a missing prop (object-typed default)", async () => {
    // Use an object-typed default so the binding local is externref — the
    // f64 explicit-undefined sentinel for numeric defaults is deferred to
    // #1553e and is out of scope here.
    const exports = await compileToWasm(`
      export function f(): number {
        let { a = { v: 7 } } = ({} as any);
        return (a as any).v;
      }
    `);
    expect(exports.f()).toBe(7);
  });

  it("present prop overrides its default", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let { a = { v: 7 } } = ({ a: { v: 99 } } as any);
        return (a as any).v;
      }
    `);
    expect(exports.f()).toBe(99);
  });

  it("null property does not trigger a sibling default", async () => {
    // default-on-undefined-OR-null distinction (#1432): a present `null`
    // value must be kept, not replaced by the default.
    const exports = await compileToWasm(`
      export function f(): number {
        let { a = 5 } = ({ a: null } as any);
        return a === null ? 1 : 0;
      }
    `);
    expect(exports.f()).toBe(1);
  });

  it("rest binding collects remaining own properties", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let { a, ...rest } = ({ a: 1, b: 2, c: 3 } as any);
        return a + (rest as any).b + (rest as any).c;
      }
    `);
    expect(exports.f()).toBe(6);
  });

  it("destructuring a null RHS through a non-empty pattern throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        try {
          let { a } = (null as any);
          return a;
        } catch {
          return 7;
        }
      }
    `);
    expect(exports.f()).toBe(7);
  });

  it("renamed binding with default", async () => {
    const exports = await compileToWasm(`
      export function f(): number {
        let { p: q = 11 } = ({} as any);
        return q;
      }
    `);
    expect(exports.f()).toBe(11);
  });
});
