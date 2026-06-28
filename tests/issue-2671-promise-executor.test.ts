// #2671 (ES2015 builtin residual) — GetCapabilitiesExecutor functions
// (§27.2.1.5.1 / sec-getcapabilitiesexecutor-functions).
//
// Root cause: V8's `Promise.resolve.call(C)` / `Promise.reject.call(C)` run
// PromiseResolve(C) → NewPromiseCapability(C) → `Construct(C, «executor»)`,
// exactly like the four aggregators (`Promise.all.call(C, …)` etc.). When `C`
// is a user `function NotPromise(executor){ executor(fn1, fn2); }` lowered to a
// WasmGC closure, the `executor(...)` call must wrap its closure arguments into
// host-callable functions through the `__call_function` host helper — otherwise
// V8's NewPromiseCapability throws "Promise resolve or reject function is not
// callable" (the wasm closures reach V8 as opaque structs).
//
// The codegen gate `calleeIsCapabilityCtorParam` recognised only the four
// aggregator combinators, so the `Promise.resolve`/`Promise.reject` capability
// sites fell through and the executor's closure args were never wrapped. Fix:
// add `resolve`/`reject` to the scanned combinator set
// (src/codegen/expressions/calls.ts). This flips the six
// `built-ins/Promise/executor-function-*` test262 files.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function captureExecutor(method: "resolve" | "reject"): Promise<any> {
  // Mirrors built-ins/Promise/executor-function-*.js: a non-Promise constructor
  // captures the GetCapabilitiesExecutor function V8 hands to `new C(executor)`.
  const src = `export function test(): any {
    var executorFunction;
    function NotPromise(executor) {
      executorFunction = executor;
      executor(function() {}, function() {});
    }
    Promise.${method}.call(NotPromise);
    return executorFunction;
  }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  const w: any = wrapExports(instance.exports, { signatures: result.exportSignatures });
  return w.test();
}

describe("#2671 — Promise GetCapabilitiesExecutor functions", () => {
  for (const method of ["resolve", "reject"] as const) {
    describe(`Promise.${method}.call(NotPromise)`, () => {
      it("captures a callable executor (NewPromiseCapability no longer throws)", async () => {
        const ef = await captureExecutor(method);
        expect(typeof ef).toBe("function");
      });

      it("the executor is extensible (executor-function-extensible)", async () => {
        const ef = await captureExecutor(method);
        expect(Object.isExtensible(ef)).toBe(true);
      });

      it("has length 2 (executor-function-length)", async () => {
        const ef = await captureExecutor(method);
        expect(ef.length).toBe(2);
      });

      it("has the empty-string name (executor-function-name)", async () => {
        const ef = await captureExecutor(method);
        expect(ef.name).toBe("");
      });

      it("is not a constructor — no own .prototype (executor-function-not-a-constructor)", async () => {
        const ef = await captureExecutor(method);
        expect(Object.prototype.hasOwnProperty.call(ef, "prototype")).toBe(false);
      });

      it("[[Prototype]] is Function.prototype (executor-function-prototype)", async () => {
        const ef = await captureExecutor(method);
        expect(Object.getPrototypeOf(ef)).toBe(Function.prototype);
      });

      it("own-property order is length,name (executor-function-property-order)", async () => {
        const ef = await captureExecutor(method);
        const names = Object.getOwnPropertyNames(ef);
        const li = names.indexOf("length");
        const ni = names.indexOf("name");
        expect(li).toBeGreaterThanOrEqual(0);
        expect(ni).toBe(li + 1);
      });
    });
  }
});
