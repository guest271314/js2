import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1511 arguments object fidelity", () => {
  it("class method 0 formals overflow direct", async () => {
    const exports = await compileToWasm(`
      class C {
        m(): number { return arguments.length; }
      }
      export function test(): number {
        return new C().m(42, 99);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("static class method 0 formals overflow direct", async () => {
    const exports = await compileToWasm(`
      class C {
        static m(): number { return arguments.length; }
      }
      export function test(): number {
        return C.m(42, 99);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("object method 0 formals overflow", async () => {
    const exports = await compileToWasm(`
      const obj = {
        m(): number { return arguments.length; }
      };
      export function test(): number {
        return obj.m(42, 99);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("async generator class method overflow", async () => {
    const exports = await compileToWasm(`
      class C {
        async *m(): any { yield arguments.length; }
      }
      export async function test(): Promise<number> {
        const c = new C();
        const it = c.m(42, 99);
        const r = await it.next();
        return r.value;
      }
    `);
    expect(await (exports as any).test()).toBe(2);
  });

  it("function arg overflow same arity ref", async () => {
    const exports = await compileToWasm(`
      function f(a: any, b: any): number { return arguments.length; }
      export function test(): number {
        const ref = f;
        return ref(42, 99);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("C.prototype.method(args) overflow", async () => {
    const exports = await compileToWasm(`
      class C {
        m(): number { return arguments.length; }
      }
      export function test(): number {
        return C.prototype.m(42, 99 as any);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });
});

// #1511 — mapped arguments descriptor fidelity / link-break (§10.4.4.2 /
// §10.4.4.5). Making a mapped index non-writable, an accessor, or deleting it
// severs the param↔arguments mapping for that slot; setting only
// `configurable`/`enumerable` leaves the map intact.
describe("#1511 mapped arguments descriptor link-break", () => {
  it("defineProperty writable:false severs the param→arguments link", async () => {
    const exports = await compileToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { writable: false });
        a = 2;
        return arguments[0];
      }
      export function test(): any { return fn(1); }
    `);
    expect((exports as any).test()).toBe(1);
  });

  it("defineProperty configurable:false alone keeps the mapping", async () => {
    const exports = await compileToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { configurable: false });
        a = 2;
        return arguments[0];
      }
      export function test(): any { return fn(1); }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("set-by-param then writable:false freezes the current value", async () => {
    const exports = await compileToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { configurable: false });
        a = 2;
        Object.defineProperty(arguments, "0", { writable: false });
        a = 3;
        return arguments[0];
      }
      export function test(): any { return fn(1); }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("an accessor descriptor on a mapped index severs the param→arguments link", async () => {
    // Defining the slot as an accessor removes the mapping, so the later
    // `a = 2` must NOT flow into arguments[0]. (Routing reads through the
    // defined getter on the wasmGC-backed arguments vec is a separate gap —
    // here we only assert the link was severed.)
    const exports = await compileToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { get: function (): number { return 99; } });
        a = 2;
        return arguments[0];
      }
      export function test(): any { return fn(1); }
    `);
    expect((exports as any).test()).not.toBe(2);
  });

  it("delete arguments[i] stops the param write from propagating", async () => {
    const exports = await compileToWasm(`
      function fn(a: any): any {
        delete arguments[0];
        a = 2;
        return arguments[0];
      }
      export function test(): any { return fn(1); }
    `);
    expect((exports as any).test()).not.toBe(2);
  });

  it("does not disturb the normal mapped link", async () => {
    const fwd = await compileToWasm(`
      function fn(a: any): any { a = 5; return arguments[0]; }
      export function test(): any { return fn(1); }
    `);
    expect((fwd as any).test()).toBe(5);

    const rev = await compileToWasm(`
      function fn(a: any): any { arguments[0] = 7; return a; }
      export function test(): any { return fn(1); }
    `);
    expect((rev as any).test()).toBe(7);
  });
});
