import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// #3046 — JSON.parse reviver `this`-binding to the holder.
//
// Per ECMA-262 §25.5.1.1 InternalizeJSONProperty, the reviver is invoked as
// Call(reviver, holder, «name, val») — `this` inside the reviver MUST be the
// holder object/array. The reviver callback was wrapped via the bare
// `__make_callback` bridge (arrow, drops the receiver), so `this` read a
// non-object and any `this.`-op (e.g. `Object.defineProperty(this, …)`) threw
// "called on non-object". A `this`-using reviver now routes through the
// `this`-forwarding `__make_getter_callback` bridge (needsThis), gated to
// JSON.parse's 2nd argument so ordinary callbacks are untouched.
describe("#3046 JSON.parse reviver this-binding to holder", () => {
  it("this is the holder array (this.length observable)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var r: any = JSON.parse('[10,20]', function (k: any, v: any): any {
          if (k === '0') return (this as any).length; // holder is [10,20] → 2
          return v;
        });
        return r[0] + r[1]; // 2 + 20 = 22
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.defineProperty(this, …) in a reviver does not throw (array holder)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var arr: any = JSON.parse('[1,2]', function (k: any, v: any): any {
          if (k === '0') {
            Object.defineProperty(this, '1', { configurable: false });
          }
          if (k === '1') return 22;
          return v;
        });
        // '1' made non-configurable at key '0'; the later CreateDataProperty(22)
        // fails silently ⇒ arr[1] stays 2.
        return arr[0] * 10 + arr[1]; // 12
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("this is the holder object (this[key] readable inside reviver)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var r: any = JSON.parse('{"a":3,"b":4}', function (k: any, v: any): any {
          if (k === 'a') {
            // holder has both own keys at reviver time; read a sibling via this
            return (this as any).b + v; // 4 + 3 = 7
          }
          return v;
        });
        return r.a + r.b; // 7 + 4 = 11
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("reviver without `this` is unchanged (value transform still routes normally)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var r: any = JSON.parse('[1,2,3]', function (k: any, v: any): any {
          return typeof v === 'number' ? v + 1 : v;
        });
        return r[0] + r[1] + r[2]; // 2 + 3 + 4 = 9
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
