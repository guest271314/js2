import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// #3021 RC1 — paren-blind receiver classification in compilePropertyIntrospection.
// The test262 harness rewrites `Object.prototype.hasOwnProperty.call(X, k)` to
// `(X).hasOwnProperty(k)` — a PARENTHESIZED receiver. Before the fix, the
// AST-based prototype-vs-instance classifier did not `ts.skipParentheses` the
// receiver, so `(C.prototype).hasOwnProperty(...)` was misclassified as an
// instance receiver and constant-folded the INVERTED answer (a field read as
// "own", a method read as "not own"). These cases pin the corrected behavior
// against Node semantics.
describe("#3021 paren-wrapped receiver in property introspection", () => {
  it("(C.prototype).hasOwnProperty: method is own, instance field is not", async () => {
    await assertEquivalent(
      `class C {
        b: number = 1;
        m(): number { return 2; }
      }
      export function test(): number {
        const bOnProto = (C.prototype).hasOwnProperty("b") ? 1 : 0; // 0: field not on proto
        const mOnProto = (C.prototype).hasOwnProperty("m") ? 1 : 0; // 1: method IS on proto
        return bOnProto * 10 + mOnProto;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("paren and non-paren prototype receivers agree", async () => {
    await assertEquivalent(
      `class C {
        x: number = 5;
        foo(): number { return 7; }
      }
      export function test(): number {
        const p1 = (C.prototype).hasOwnProperty("foo") ? 1 : 0;
        const p2 = C.prototype.hasOwnProperty("foo") ? 1 : 0;
        const p3 = (C.prototype).hasOwnProperty("x") ? 1 : 0;
        const p4 = C.prototype.hasOwnProperty("x") ? 1 : 0;
        return p1 * 1000 + p2 * 100 + p3 * 10 + p4; // 1100
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("(instance).hasOwnProperty: field is own, method is not", async () => {
    await assertEquivalent(
      `class C {
        a: number = 3;
        g(): number { return 9; }
      }
      export function test(): number {
        const c = new C();
        const aOwn = (c).hasOwnProperty("a") ? 1 : 0; // 1: field on instance
        const gOwn = (c).hasOwnProperty("g") ? 1 : 0; // 0: method on proto
        return aOwn * 10 + gOwn;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.prototype.hasOwnProperty.call on prototype (harness-native form)", async () => {
    await assertEquivalent(
      `class C {
        v: number = 4;
        h(): number { return 8; }
      }
      export function test(): number {
        const field = Object.prototype.hasOwnProperty.call(C.prototype, "v") ? 1 : 0; // 0
        const method = Object.prototype.hasOwnProperty.call(C.prototype, "h") ? 1 : 0; // 1
        return field * 10 + method;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("(C.prototype).propertyIsEnumerable: methods are non-enumerable", async () => {
    await assertEquivalent(
      `class C {
        k: number = 2;
        method(): number { return 6; }
      }
      export function test(): number {
        // Methods on the prototype are own but NON-enumerable.
        const e = (C.prototype).propertyIsEnumerable("method") ? 1 : 0; // 0
        return e;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
