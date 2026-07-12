// #2623 §P7 slice P-7b — B-4 observable-resolve + Promise realm unification.
//
// Covers the test262 flips:
//   built-ins/Promise/all/invoke-resolve.js
//   built-ins/Promise/race/invoke-resolve.js
//   built-ins/Promise/allSettled/invoke-resolve.js
//   built-ins/Promise/try/promise.js  (local sandbox-runner lane)
// and the guard against the historical composed-regression:
//   built-ins/Promise/any/invoke-then.js (realm-split assimilation hop)
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function makeSandbox(): Record<string, any> {
  const sandbox = Object.create(null) as Record<string, any>;
  const ctx = createContext(sandbox);
  for (const n of ["Promise", "Array", "Object", "Function", "TypeError"]) {
    sandbox[n] = runInContext(n, ctx);
  }
  sandbox.globalThis = sandbox;
  return sandbox;
}

async function run(src: string, sandbox?: Record<string, any>): Promise<{ ret: unknown; sandbox: any }> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    deferTopLevelInit: true,
    skipSemanticDiagnostics: true,
  });
  const errors = (result.errors ?? []).filter((e: any) => e.severity === "error");
  expect(errors.map((e: any) => e.message).join("; ")).toBe("");
  const sb = sandbox ?? makeSandbox();
  const imports: any = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: sb });
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  (instance.exports as any).__module_init?.();
  return { ret: (instance.exports as any).test?.(), sandbox: sb };
}

describe("#2623 P-7b — B-4: observable Get(C,'resolve') through the combinators", () => {
  it("a top-level `Promise.resolve = fn` patch is invoked by Promise.all with identity, 1 arg, this===Promise", async () => {
    const { ret } = await run(`
      var p1 = new Promise(function() {});
      var resolve = Promise.resolve;
      var callCount = 0;
      var identityOk = -1;
      var argLen = -1;
      var thisIsPromise = -1;
      Promise.resolve = function(nextValue) {
        identityOk = (nextValue === p1) ? 1 : 0;
        argLen = arguments.length;
        thisIsPromise = (this === Promise) ? 1 : 0;
        callCount += 1;
        return resolve.apply(Promise, arguments);
      };
      export function test(): number {
        Promise.all([p1]);
        if (callCount !== 1) return 2;
        if (identityOk !== 1) return 3;
        if (argLen !== 1) return 4;
        if (thisIsPromise !== 1) return 5;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Promise.any invokes the instance's own patched `then` (realm-unified minting — no assimilation hop)", async () => {
    const { ret } = await run(`
      var promise = Promise.resolve();
      var callCount = 0;
      var thisOk = -1;
      promise.then = function(resolver, rejectElement) {
        thisOk = (this === promise) ? 1 : 0;
        callCount++;
        return {};
      };
      export function test(): number {
        Promise.any([promise]);
        if (callCount !== 1) return 2;
        if (thisOk !== 1) return 3;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Promise.try instance carries the observable Promise identity (constructor === Promise, instanceof)", async () => {
    const { ret } = await run(`
      var instance = Promise.try(function () {});
      export function test(): number {
        if (instance.constructor !== Promise) return 2;
        if (!(instance instanceof Promise)) return 3;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Promise.resolve / new Promise mint from the observable realm (constructor identity)", async () => {
    const { ret } = await run(`
      var a = Promise.resolve(1);
      var b = new Promise(function(res) { res(2); });
      export function test(): number {
        if (a.constructor !== Promise) return 2;
        if (b.constructor !== Promise) return 3;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("without a sandbox, minting stays on the host intrinsic (no behavior change)", async () => {
    const result: any = await compile(
      `
      export function test(): any {
        return Promise.resolve(7);
      }
    `,
      { fileName: "test.ts", deferTopLevelInit: true, skipSemanticDiagnostics: true },
    );
    const imports: any = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports);
    (instance.exports as any).__module_init?.();
    const p = (instance.exports as any).test();
    expect(p).toBeInstanceOf(Promise);
    expect(p.constructor).toBe(Promise);
    expect(await p).toBe(7);
  });
});
