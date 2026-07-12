// #2623 §P7 slice P-7 — host-lane Promise bridge fidelity (B-1 reflection +
// B-5 §27.2.5.3 synchronous semantics + the typeof unsound-fold residuals).
//
// Covers the four test262 flips this slice banked:
//   built-ins/Promise/prototype/finally/invokes-then-with-function.js
//   built-ins/Promise/prototype/finally/invokes-then-with-non-function.js
//   built-ins/Promise/prototype/finally/this-value-then-poisoned.js
//   built-ins/Promise/prototype/finally/this-value-then-throws.js
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<{ ret: unknown; exports: any }> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    deferTopLevelInit: true,
    skipSemanticDiagnostics: true,
  });
  const errors = (result.errors ?? []).filter((e: any) => e.severity === "error");
  expect(errors.map((e: any) => e.message).join("; ")).toBe("");
  const imports: any = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  (instance.exports as any).__module_init?.();
  return { ret: (instance.exports as any).test?.(), exports: instance.exports };
}

describe("#2623 P-7 — B-1: host→wasm callback arguments.length reflection", () => {
  it("a patched `then` invoked by native .finally observes exactly 2 args (not the padded dispatcher arity)", async () => {
    const { ret } = await run(`
      var target = new Promise(function() {});
      var callCount = 0;
      var thisIsTarget = -1;
      var argCount = -1;
      target.then = function(a, b) {
        callCount += 1;
        thisIsTarget = (this === target) ? 1 : 0;
        argCount = arguments.length;
        return {};
      };
      var handler = function() {};
      export function test(): number {
        Promise.prototype.finally.call(target, handler, 2, 3);
        if (callCount !== 1) return 2;
        if (thisIsTarget !== 1) return 3;
        if (argCount !== 2) return 4;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it(".finally result IS the patched then's return value (identity, no fulfilled-wrap re-wrap)", async () => {
    const { ret } = await run(`
      var target = new Promise(function() {});
      var returnValue = {};
      target.then = function(a, b) { return returnValue; };
      export function test(): number {
        var result = Promise.prototype.finally.call(target, function() {});
        return result === returnValue ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("__closure_arity export reports declared formal counts (and -1 for non-closures)", async () => {
    const { exports } = await run(`
      var keep2 = function(a, b) { return a; };
      var keep0 = function() { return 7; };
      export function grab2(): any { return keep2; }
      export function grab0(): any { return keep0; }
      export function test(): number { return 1; }
    `);
    const arityFn = (exports as any).__closure_arity;
    expect(typeof arityFn).toBe("function");
    expect(arityFn((exports as any).grab2())).toBe(2);
    expect(arityFn((exports as any).grab0())).toBe(0);
    expect(arityFn(null)).toBe(-1);
  });
});

describe("#2623 P-7 — B-5: §27.2.5.3 synchronous abrupt completion through .finally()", () => {
  it("a poisoned `then` accessor throws SYNCHRONOUSLY from p.finally() (not a rejection)", async () => {
    const { ret } = await run(`
      var poisonedThen = Object.defineProperty(new Promise(function() {}), 'then', {
        get: function() { throw new Error("POISON"); }
      });
      export function test(): number {
        var callForm = 0;
        var methodForm = 0;
        try { Promise.prototype.finally.call(poisonedThen); } catch (e) { callForm = 1; }
        try { poisonedThen.finally(); } catch (e) { methodForm = 1; }
        if (callForm !== 1) return 2;
        if (methodForm !== 1) return 3;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("a throwing patched `then` data property propagates synchronously from p.finally()", async () => {
    const { ret } = await run(`
      var thrower = new Promise(function() {});
      thrower.then = function() { throw new Error("BOOM"); };
      export function test(): number {
        var callForm = 0;
        var methodForm = 0;
        try { Promise.prototype.finally.call(thrower); } catch (e) { callForm = 1; }
        try { thrower.finally(); } catch (e) { methodForm = 1; }
        if (callForm !== 1) return 2;
        if (methodForm !== 1) return 3;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("well-behaved .finally(cb) still chains (wrap removal does not break the happy path)", async () => {
    const { ret } = await run(`
      export function test(): any {
        var p = Promise.resolve(41);
        return p.finally(function() {});
      }
    `);
    expect(await (ret as Promise<number>)).toBe(41);
  });
});

describe("#2623 P-7 — typeof over closure-mutated bindings (unsound null-narrow fold)", () => {
  it("typeof reads the runtime value when a null-initialized var is assigned inside a closure", async () => {
    const { ret } = await run(`
      var target = new Promise(function() {});
      var resolve = null;
      target.then = function(a, b) { resolve = a; return {}; };
      export function test(): number {
        Promise.prototype.finally.call(target, function() {});
        // standalone typeof expression
        var t = typeof resolve;
        if (t !== "function") return 2;
        // typeof comparison lowering
        if (typeof resolve !== "function") return 3;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("intentional null narrowing still yields 'object' at runtime", async () => {
    const { ret } = await run(`
      var x = null;
      var mutate = function() { x = 5; };
      export function test(): number {
        // x is genuinely null HERE (mutate never called before this read) —
        // the runtime path must still answer "object".
        if (typeof x !== "object") return 2;
        mutate();
        if (typeof x !== "number") return 3;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });
});
