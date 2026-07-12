// #2623 §P7 slice P-7b — B-4 observable-resolve (CI-lane / single-realm model).
//
// Design decision (see the P-7b DESIGN DECISION section in
// plan/issues/2623-promise-capability-cluster-multihop-callback-cast.md):
// the observable-resolve contract is served in the SINGLE-REALM lane only.
// A top-level `Promise.resolve = fn` patch is kept in `__module_init`
// (declarations.ts) and lands on the `declared_global`-resolved Promise:
//   - CI lane (no vm sandbox): that IS `globalThis.Promise` — the same object
//     `_resolveCtor(directCall=1)` hands V8 as the capability C, so
//     `Get(C,"resolve")` observes the patch (§27.2.4.1.1 step 5). The CI
//     worker's #1220 static snapshot/restore un-patches it after each test.
//   - LOCAL sandboxed runner: the patch lands on the SANDBOX Promise and is
//     deliberately inert for the host-realm capability lane (partial realm
//     unification was prototyped and reverted — it leaks across builtins).
//     The `["Promise","resolve"]` SENTINEL_KEYS entry discards the dirty
//     sandbox before the next test.
//
// Covers the test262 CI flips:
//   built-ins/Promise/all/invoke-resolve.js
//   built-ins/Promise/race/invoke-resolve.js
//   built-ins/Promise/allSettled/invoke-resolve.js
// and the guard against the historical composed-regression:
//   built-ins/Promise/any/invoke-then.js (constructor-identity fast path)
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

/** Compile + instantiate. No sandbox = the CI worker lane (single realm). */
async function run(src: string, sandbox?: Record<string, any>): Promise<{ ret: unknown; sandbox: any }> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    deferTopLevelInit: true,
    skipSemanticDiagnostics: true,
  });
  const errors = (result.errors ?? []).filter((e: any) => e.severity === "error");
  expect(errors.map((e: any) => e.message).join("; ")).toBe("");
  const imports: any = buildImports(
    result.imports,
    undefined,
    result.stringPool,
    sandbox ? { globalSandbox: sandbox } : undefined,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  (instance.exports as any).__module_init?.();
  return { ret: (instance.exports as any).test?.(), sandbox };
}

/**
 * The single-realm tests patch the REAL `Promise` statics of this vitest
 * process (exactly what the CI fork worker experiences). Snapshot + restore
 * around each test — the in-repo twin of the worker's #1220 restore.
 */
async function withPromiseStaticsRestored<T>(fn: () => Promise<T>): Promise<T> {
  const orig = Object.getOwnPropertyDescriptor(Promise, "resolve");
  try {
    return await fn();
  } finally {
    if (orig) Object.defineProperty(Promise, "resolve", orig);
  }
}

describe("#2623 P-7b — B-4: observable Get(C,'resolve') in the single-realm (CI) lane", () => {
  it("a top-level `Promise.resolve = fn` patch is invoked by Promise.all with identity, 1 arg, this===Promise", async () => {
    await withPromiseStaticsRestored(async () => {
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
  });

  it("Promise.race observes the patched resolve too (same Get(C,'resolve') contract)", async () => {
    await withPromiseStaticsRestored(async () => {
      const { ret } = await run(`
        var p1 = new Promise(function() {});
        var resolve = Promise.resolve;
        var callCount = 0;
        Promise.resolve = function(nextValue) {
          callCount += 1;
          return resolve.apply(Promise, arguments);
        };
        export function test(): number {
          Promise.race([p1]);
          return callCount === 1 ? 1 : 2;
        }
      `);
      expect(ret).toBe(1);
    });
  });

  it("Promise.any invokes the instance's own patched `then` (constructor-identity fast path intact)", async () => {
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

  it("Promise.try / Promise.resolve / new Promise instances carry Promise identity (single realm)", async () => {
    const { ret } = await run(`
      var instance = Promise.try(function () {});
      var a = Promise.resolve(1);
      var b = new Promise(function(res) { res(2); });
      export function test(): number {
        if (instance.constructor !== Promise) return 2;
        if (!(instance instanceof Promise)) return 3;
        if (a.constructor !== Promise) return 4;
        if (b.constructor !== Promise) return 5;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("minting stays on the host intrinsic (no behavior change vs main)", async () => {
    const { ret } = await run(`
      export function test(): any {
        return Promise.resolve(7);
      }
    `);
    expect(ret).toBeInstanceOf(Promise);
    expect((ret as any).constructor).toBe(Promise);
    expect(await ret).toBe(7);
  });
});

describe("#2623 P-7b — local sandboxed lane: the patch is isolated, never realm-unified", () => {
  it("a top-level `Promise.resolve = fn` patch lands on the SANDBOX Promise, host Promise untouched", async () => {
    const sb = makeSandbox();
    const hostResolve = Promise.resolve;
    const sandboxResolveBefore = sb.Promise.resolve;
    await run(
      `
      Promise.resolve = function(v) { return v; };
      export function test(): number { return 1; }
    `,
      sb,
    );
    // Host realm is never polluted by a sandboxed test.
    expect(Promise.resolve).toBe(hostResolve);
    // The patch landed on the sandbox Promise — this is what the runner's
    // ["Promise","resolve"] SENTINEL_KEYS entry dirty-detects and discards.
    expect(sb.Promise.resolve).not.toBe(sandboxResolveBefore);
  });

  it("cross-builtin realm invariant: Object.getPrototypeOf(Promise.prototype) === Object.prototype (the proto.js guard)", async () => {
    // This is the row partial realm unification regressed
    // (built-ins/Promise/prototype/proto.js): Promise sandbox-first while
    // Object stayed host-realm made the compare cross-realm. With the
    // host-realm design both sides resolve in one realm.
    const { ret } = await run(
      `
      export function test(): number {
        return Object.getPrototypeOf(Promise.prototype) === Object.prototype ? 1 : 2;
      }
    `,
      makeSandbox(),
    );
    expect(ret).toBe(1);
  });
});
