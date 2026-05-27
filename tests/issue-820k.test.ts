/**
 * #820k — Object.* receiver TypeError on null/undefined (ToObject step).
 *
 * ES §20.1.2 Object methods perform ToObject(O) (§7.1.18) on their argument
 * before enumerating. ToObject throws a TypeError on null/undefined. The host
 * import handlers for Object.keys/values/entries/getOwnPropertyNames previously
 * returned an empty array instead of throwing.
 */

import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#820k Object.* receiver ToObject TypeError", () => {
  const throwsTypeError = (method: string, arg: "null" | "undefined") => `
    export function test(): number {
      try {
        Object.${method}(${arg} as any);
        return 0;
      } catch (e) {
        return e instanceof TypeError ? 1 : 2;
      }
    }
  `;

  for (const method of ["keys", "values", "entries", "getOwnPropertyNames"]) {
    for (const arg of ["null", "undefined"] as const) {
      it(`Object.${method}(${arg}) throws TypeError`, async () => {
        const exports = await compileToWasm(throwsTypeError(method, arg));
        expect((exports as any).test()).toBe(1);
      });
    }
  }

  it("Object.keys on a real object still enumerates", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Object.keys({ a: 1, b: 2 }).length;
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("Object.values on a real object still enumerates", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const v = Object.values({ a: 10, b: 20 });
        return (v[0] as number) + (v[1] as number);
      }
    `);
    expect((exports as any).test()).toBe(30);
  });

  it("Object.keys autoboxes a primitive string (#1129)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Object.keys("ab").length;
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("Object.freeze(undefined) does not throw (non-object passthrough)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Object.freeze(undefined as any) === undefined ? 1 : 0;
      }
    `);
    expect((exports as any).test()).toBe(1);
  });
});
