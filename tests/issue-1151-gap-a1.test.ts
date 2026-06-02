import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// Issue #1151 Gap A1: `isAsyncCallExpression` missed call shapes whose callee
// has no reachable `async` declaration but whose call signature returns
// `Promise<T>` — most importantly a callback parameter typed
// `() => Promise<T>`. Such calls were not wrapped by `wrapAsyncCallInTryCatch`
// (#1150), so a synchronous throw in the callee trapped at the wasm boundary
// instead of surfacing as a rejected Promise.
//
// The fix adds a fallback in `isAsyncCallExpression` (expressions.ts): after
// the decl-modifier check, inspect the callee type's CALL signatures and treat
// the call as async if any returns a Promise. Construct signatures (`new`) are
// excluded by `getCallSignatures()`; async generators return AsyncGenerator
// (not Promise) so `isPromiseType` is already false for them.
//
// Spec: ECMA-262 §27.7.5.2 AsyncFunctionStart — an async function always
// returns a Promise; a synchronous throw must become a rejected Promise.

describe("issue #1151 Gap A1 — broaden async-call detection", () => {
  it("a Promise-returning callback param: call result is a thenable, not a trap", async () => {
    const src = `
      function invoke(cb: () => Promise<number>): number {
        const p: any = cb();
        return p && typeof p.then === "function" ? 1 : 0;
      }
      async function thrower(): Promise<number> { throw 7; }
      export function run(): number {
        return invoke(thrower);
      }
    `;
    const exports = await compileToWasm(src);
    let trapped = false;
    let val: unknown;
    try {
      val = (exports as Record<string, () => unknown>).run();
    } catch {
      trapped = true;
    }
    expect(trapped).toBe(false);
    expect(val).toBe(1);
    // Swallow the unhandled rejection from the thrower() Promise (no handler attached).
    await Promise.resolve();
  });

  it("variable holding an async function ref: call wraps the sync throw", async () => {
    const src = `
      async function ax(): Promise<number> { throw 42; }
      export function run(): number {
        const f = ax;
        const p: any = f();
        return p && typeof p.then === "function" ? 1 : 0;
      }
    `;
    const exports = await compileToWasm(src);
    const val = (exports as Record<string, () => unknown>).run();
    expect(val).toBe(1);
    await Promise.resolve();
  });

  it("sync function declared to return Promise<T>: result is still a thenable", async () => {
    // The fix intentionally also wraps sync functions whose declared return is
    // Promise<T> — a sync throw from such a function still violates the
    // Promise contract and must reject. Here the function does not throw, so
    // the only observable effect is that the result is a real Promise.
    const src = `
      function makeP(): Promise<number> { return Promise.resolve(5); }
      export function run(): number {
        const p: any = makeP();
        return p && typeof p.then === "function" ? 1 : 0;
      }
    `;
    const exports = await compileToWasm(src);
    const val = (exports as Record<string, () => unknown>).run();
    expect(val).toBe(1);
    await Promise.resolve();
  });

  it("a non-Promise-returning callback is NOT treated as async", async () => {
    // Guard against over-broadening: a plain `() => number` callback must not
    // get Promise-wrapped — its result stays a raw number.
    const src = `
      function invoke(cb: () => number): number {
        return cb();
      }
      function plain(): number { return 11; }
      export function run(): number {
        return invoke(plain);
      }
    `;
    const exports = await compileToWasm(src);
    const val = (exports as Record<string, () => unknown>).run();
    expect(val).toBe(11);
  });
});
