import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2745 — Function.prototype.bind residual: bound partial-application args,
// bound [[Construct]] arg concatenation, restricted-property poison, plus the
// HOF over-arity `arguments.length` correctness the dispatcher fix restores.
async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compile failed: ${r.errors.map((e) => `L${e.line}: ${e.message}`).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#2745 Function.prototype.bind residual", () => {
  // ---- (a) bound partial-application arguments + over-arity forwarding ----

  it("bound function forwards call-time args to a 0-formal target's arguments", async () => {
    expect(
      await run(`
        function func() { return arguments[0] === 1; }
        export function test(): number {
          var newFunc = Function.prototype.bind.call(func);
          return newFunc(1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("bound this + over-arity arguments are all observed", async () => {
    expect(
      await run(`
        var obj = { prop: "abc" };
        var func = function(x) {
          return this === obj && x === 1 && arguments[1] === 2 &&
            arguments[0] === 1 && arguments.length === 2 && this.prop === "abc";
        };
        export function test(): number {
          var newFunc = Function.prototype.bind.call(func, obj);
          return newFunc(1, 2) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("bound partial args concatenate before call-time args", async () => {
    expect(
      await run(`
        function func() {
          return arguments.length === 2 && arguments[0] === 1 && arguments[1] === 2;
        }
        export function test(): number {
          var newFunc = Function.prototype.bind.call(func, undefined, 1);
          return newFunc(2) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // ---- (b) bound [[Construct]] applies bound + call args ----

  it("new boundFn(...) applies the call-time args and returns the instance", async () => {
    expect(
      await run(`
        var func = function(x, y, z) {
          var o = {};
          o.returnValue = x + y + z;
          o.ok = arguments[0] === "a" && arguments.length === 3;
          return o;
        };
        export function test(): number {
          var NewFunc = Function.prototype.bind.call(func, {});
          var inst = new NewFunc("a", "b", "c");
          return (inst.returnValue === "abc" && inst.ok === true) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("new boundFn(...) concatenates bound partial args with construct args", async () => {
    expect(
      await run(`
        var func = function(a, b, c) {
          return new Boolean(a === 1 && b === 2 && c === 3 && arguments.length === 3);
        };
        export function test(): number {
          var NewFunc = Function.prototype.bind.call(func, {}, 1, 2);
          var inst = new NewFunc(3);
          return inst.valueOf() === true ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // ---- (d) restricted caller/arguments poison ----

  it("writing bound.arguments throws a catchable TypeError", async () => {
    expect(
      await run(`
        function target() {}
        export function test(): number {
          var bound = target.bind(null);
          var threw = 0;
          try { (bound as any).arguments = {}; } catch (e) { if (e instanceof TypeError) threw = 1; }
          return threw;
        }
      `),
    ).toBe(1);
  });

  it("reading bound.caller throws a catchable TypeError", async () => {
    expect(
      await run(`
        function target() {}
        export function test(): number {
          var bound = target.bind(null);
          var threw = 0;
          try { var x = (bound as any).caller; } catch (e) { if (e instanceof TypeError) threw = 1; }
          return threw;
        }
      `),
    ).toBe(1);
  });

  // ---- regression guard: HOF over-arity arguments.length must be exact ----
  // The dispatcher #820l `__argc` convention is now clamped-to-formals, so an
  // arity-mismatched callback's `arguments.length` matches V8 (was doubled).

  it("forEach callback sees arguments.length === 3 (value,index,array)", async () => {
    expect(
      await run(`
        export function test(): number {
          var seen = 0;
          [10, 20].forEach(function() { seen = arguments.length; });
          return seen;
        }
      `),
    ).toBe(3);
  });

  it("map callback (1 formal) sees arguments.length === 3", async () => {
    expect(
      await run(`
        export function test(): number {
          var arr = [5].map(function(v: number) { return arguments.length; });
          return arr[0];
        }
      `),
    ).toBe(3);
  });
});
