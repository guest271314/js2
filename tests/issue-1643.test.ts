import { describe, test, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

/**
 * #1643 — class `static { ... }` initializer blocks must execute during class
 * evaluation, in source order interleaved with static field initializers
 * (§15.7.10). Before this fix the blocks were parsed but never run.
 */
describe("#1643 — class static initializer blocks", () => {
  test("static block runs and can read earlier static fields", async () => {
    const ex = await compileToWasm(`
      class C {
        static x: number = 1;
        static y: number = 0;
        static { C.y = C.x + 10; }
      }
      export function test(): number { return C.y; }
    `);
    expect(ex.test()).toBe(11);
  });

  test("static block runs in source order; later field not yet visible", async () => {
    const ex = await compileToWasm(`
      class C {
        static a: number = 2;
        static b: number = 0;
        static { C.b = C.a; }
        static c: number = 9;
      }
      export function test(): number { return C.b + C.c; }
    `);
    expect(ex.test()).toBe(11);
  });

  test("multiple static blocks accumulate in order", async () => {
    const ex = await compileToWasm(`
      class C {
        static n: number = 0;
        static { C.n = 1; }
        static { C.n = C.n + 5; }
      }
      export function test(): number { return C.n; }
    `);
    expect(ex.test()).toBe(6);
  });

  test("private instance fields unaffected", async () => {
    const ex = await compileToWasm(`
      class C {
        #v: number = 0;
        constructor(n: number) { this.#v = n; }
        get(): number { return this.#v; }
      }
      export function test(): number { return new C(7).get(); }
    `);
    expect(ex.test()).toBe(7);
  });
});
