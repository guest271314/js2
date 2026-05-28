// #1697: `this.X = v` in static method body must route to the staticProps
// global. Without the fix the write silently dropped (read path already
// resolved `this` to the class constructor; write path didn't).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runTest(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "p.ts" });
  if (!r.success) throw new Error("CE: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports.test as () => unknown)();
}

describe("#1697 static method this-write to staticProps", () => {
  it("writes public static field via this.X", async () => {
    const v = await runTest(`
      class C {
        static xVal: number = 5;
        static doIt() { this.xVal = 42; return this.xVal; }
      }
      export function test(): number { return C.doIt(); }
    `);
    expect(v).toBe(42);
  });

  it("writes private static field via this.#X", async () => {
    const v = await runTest(`
      class C {
        static #xVal: number = 5;
        static doIt() { this.#xVal = 42; return this.#xVal; }
      }
      export function test(): number { return C.doIt(); }
    `);
    expect(v).toBe(42);
  });

  it("private static setter pattern (test262 shape)", async () => {
    const v = await runTest(`
      var C = class {
        static #xVal: number = 0;
        static #x(value: number) {
          this.#xVal = value;
          return this.#xVal;
        }
        static x() { return this.#x(42); }
      }
      export function test(): number { return C.x(); }
    `);
    expect(v).toBe(42);
  });

  it("ClassName.publicField still works (regression guard)", async () => {
    const v = await runTest(`
      class C {
        static xVal: number = 5;
        static doIt() { C.xVal = 42; return C.xVal; }
      }
      export function test(): number { return C.doIt(); }
    `);
    expect(v).toBe(42);
  });

  it("ClassName.#privField still works (regression guard)", async () => {
    const v = await runTest(`
      class C {
        static #xVal: number = 5;
        static doIt() { C.#xVal = 42; return C.#xVal; }
      }
      export function test(): number { return C.doIt(); }
    `);
    expect(v).toBe(42);
  });

  it("instance method this.X writes are NOT misrouted to static globals", async () => {
    // Same-name public field on instance vs static — must remain disjoint.
    const v = await runTest(`
      class C {
        x: number = 1;
        static x: number = 100;
        doIt() { this.x = 7; return this.x; }
      }
      export function test(): number {
        const c = new C();
        const r = c.doIt();
        // Static C.x must be untouched (still 100); return r + (C.x===100 ? 0 : 1000)
        return r + (C.x === 100 ? 0 : 1000);
      }
    `);
    expect(v).toBe(7);
  });
});
