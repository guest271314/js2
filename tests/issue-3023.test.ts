import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3023 — iterator protocol: a custom iterable installed via a late-bound
// `obj[Symbol.iterator] = function () { return { next(){}, return(){} } }`
// lowers the returned iterator object to a closed nominal WasmGC struct whose
// `.next` / `.return` are NOT native JS properties. The host-side array
// materialization used by array destructuring (`__array_from_iter_n` →
// `_arrayFromIter` → `_drainIterable`) previously did a naive `it.next()` and
// threw "it.next is not a function". It now resolves the iterator methods via
// the sidecar / `__sget_*` / `__call_fn_0` walk and performs §7.4.6
// IteratorClose (`.return()`) on the bounded (abrupt) stop.
async function compileAndRun(source: string): Promise<number> {
  const result = await compile(source, { skipSemanticDiagnostics: true } as any);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  // Wire setExports so the host iterator bridge can call back into the
  // WasmGC iterator struct's exported members (__sget_next / __call_fn_0).
  const setExports = (imports as any).setExports;
  if (typeof setExports === "function") setExports(instance.exports);
  return (instance.exports as Record<string, Function>).test!() as number;
}

describe("#3023 — array destructuring over a custom (late-bound) iterable", () => {
  it("const [x] consumes one value and closes the not-done iterator (IteratorClose)", async () => {
    // Mirrors test262 for-of/dstr/const-ary-init-iter-close: next yields a
    // value with done:false, so after one step the iterator is still open and
    // §8.5.3 requires IteratorClose → return() called exactly once.
    const ret = await compileAndRun(`
      export function test(): number {
        let nextCount = 0;
        let returnCount = 0;
        const iterator = {
          next: function () { nextCount = nextCount + 1; return { value: 42, done: false }; },
          return: function () { returnCount = returnCount + 1; return {}; },
        };
        const iterable: any = {};
        iterable[Symbol.iterator] = function () { return iterator; };
        const [x] = iterable;
        if (x !== 42) return 100;
        if (nextCount !== 1) return 200 + nextCount;
        if (returnCount !== 1) return 300 + returnCount;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("const [x] over an already-done iterator does NOT call return() (no-close)", async () => {
    // Mirrors *-iter-nrml-close-skip: next returns done:true immediately, so
    // the iterator record is done → IteratorClose is skipped (returnCount 0).
    const ret = await compileAndRun(`
      export function test(): number {
        let nextCount = 0;
        let returnCount = 0;
        const iterator = {
          next: function () { nextCount = nextCount + 1; return { value: undefined, done: true }; },
          return: function () { returnCount = returnCount + 1; return {}; },
        };
        const iterable: any = {};
        iterable[Symbol.iterator] = function () { return iterator; };
        const [_a] = iterable;
        if (nextCount !== 1) return 200 + nextCount;
        if (returnCount !== 0) return 300 + returnCount;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("multi-element pattern binds each value and closes when still yielding", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        let nextCount = 0;
        let returnCount = 0;
        let i = 0;
        const iterator = {
          next: function () { nextCount = nextCount + 1; i = i + 1; return { value: i * 10, done: false }; },
          return: function () { returnCount = returnCount + 1; return {}; },
        };
        const iterable: any = {};
        iterable[Symbol.iterator] = function () { return iterator; };
        const [a, b] = iterable;
        if (a !== 10) return 400 + a;
        if (b !== 20) return 500 + b;
        if (nextCount !== 2) return 200 + nextCount;
        if (returnCount !== 1) return 300 + returnCount;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("for-of with array destructuring over the custom iterable", async () => {
    // for (const [x] of [iter]) — inner destructuring drives the same host path.
    const ret = await compileAndRun(`
      export function test(): number {
        let doneCallCount = 0;
        const iter: any = {};
        iter[Symbol.iterator] = function () {
          return {
            next: function () { return { value: 7, done: false }; },
            return: function () { doneCallCount = doneCallCount + 1; return {}; },
          };
        };
        let iterCount = 0;
        for (const [x] of [iter]) {
          if (x !== 7) return 400;
          if (doneCallCount !== 1) return 300 + doneCallCount;
          iterCount = iterCount + 1;
        }
        if (iterCount !== 1) return 500 + iterCount;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("assignment destructuring over the custom iterable does not close an exhausted iterator", async () => {
    // Mirrors test262 assignment/dstr/array-elem-iter-nrml-close-skip: the
    // iterator reports done on the first step, so IteratorClose is skipped.
    const ret = await compileAndRun(`
      export function test(): number {
        let nextCount = 0;
        let returnCount = 0;
        const iterator = {
          next: function () { nextCount = nextCount + 1; return { done: true, value: undefined }; },
          return: function () { returnCount = returnCount + 1; return {}; },
        };
        const iterable: any = {};
        iterable[Symbol.iterator] = function () { return iterator; };
        let _x: any;
        [_x] = iterable;
        if (nextCount !== 1) return 200 + nextCount;
        if (returnCount !== 0) return 300 + returnCount;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });
});
