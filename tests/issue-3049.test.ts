// #3049 — Iterator.prototype helper methods on plain (non-generator) iterators.
//
// Two stacked host-boundary gaps made the ~27-file codegen-signature subset of
// built-ins/Iterator/prototype/* fail:
//
// 1. CHAIN DEPTH — the `__iterator` host import synthesized array iterators
//    with a ONE-level chain (iter → %IteratorPrototype%), but the spec
//    (§23.1.5.2) mandates iter → %ArrayIteratorPrototype% → %IteratorPrototype%.
//    Tests (and the test262-runner `Iterator` shim) hardcode the spec walk
//    `getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`, which overshot
//    the helper-bearing proto onto Object.prototype — every
//    `Iterator.prototype.<helper>` lookup returned undefined. Fixed by a
//    SHARED `_getSynthArrayIteratorPrototype` middle level (identity-stable
//    across iterators).
//
// 2. ITERATOR-RECORD FAITHFULNESS — the ES2025 helpers drive their receiver
//    host-side via the spec iterator record (Call(next, iter) →
//    Get(result, "done"/"value")), which broke on compiled receivers:
//    `next` values that are raw Wasm closure structs are not host-callable
//    ("object is not a function"), and step results that are Wasm structs have
//    opaque done/value reads (infinite drive loop). Fixed by
//    `_iteratorRecordForHost` at the two `__extern_method_call` dispatch sites
//    (mirrors the #1627 GetSetRecord precedent).
//
// Known residuals (separate roots, NOT covered here): the lazy-helper captured
// counter visibility gap (#3128 family — `++captured` inside a mapper invoked
// during a later for-of mutates a detached cell), the
// `class X extends Iterator` proto-chain gap, and flatMap's
// GetIteratorFlattenable on compiled inner iterables.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#3049 — Iterator.prototype helpers on plain iterators", () => {
  it("reaches the helper proto at spec depth: getPrototypeOf^2 of an array iterator has .map", async () => {
    const exp = await run(`
      const it: any = ([] as any)[Symbol.iterator]();
      const p2: any = Object.getPrototypeOf(Object.getPrototypeOf(it));
      return typeof p2.map;
    `);
    expect(exp.test()).toBe("function");
  });

  it("keeps the middle %ArrayIteratorPrototype% level identity-stable across iterators", async () => {
    const exp = await run(`
      const a: any = ([1] as any)[Symbol.iterator]();
      const b: any = ([2, 3] as any)[Symbol.iterator]();
      return Object.getPrototypeOf(a) === Object.getPrototypeOf(b);
    `);
    expect(exp.test()).toBe(true);
  });

  // Mirrors built-ins/Iterator/prototype/Symbol.iterator/return-val.js —
  // %IteratorPrototype%[@@iterator] returns the this value.
  it("resolves @@iterator on the spec-walked %IteratorPrototype% (return-val shape)", async () => {
    const exp = await run(`
      const IteratorPrototype: any = Object.getPrototypeOf(Object.getPrototypeOf(([] as any)[Symbol.iterator]()));
      const getIterator: any = IteratorPrototype[Symbol.iterator];
      const marker: any = {};
      return getIterator.call(marker) === marker;
    `);
    expect(exp.test()).toBe(true);
  });

  // Mirrors the */this-plain-iterator.js shape (eager helper — forEach): the
  // helper must drive a plain object whose `next` is a compiled closure, and
  // the callback's captured-counter mutation must be visible.
  it("forEach.call(plainIter, cb) drives the compiled next and counts callbacks", async () => {
    const exp = await run(`
      function It(this: any): void {}
      (It as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf(([] as any)[Symbol.iterator]()));
      let count = 3;
      const iter: any = {
        next: function(): any {
          --count;
          return count >= 0 ? { done: false, value: count } : { done: true, value: undefined };
        },
      };
      let calls = 0;
      (It as any).prototype.forEach.call(iter, function(v: any): void { ++calls; });
      return calls;
    `);
    expect(exp.test()).toBe(3);
  });

  // Lazy helper (map): the record shim must bridge the compiled next AND wrap
  // the Wasm-struct step results so done/value resolve (pre-fix this looped
  // forever, or threw "object is not a function" for the accessor shape).
  it("map.call(plainIter, cb) — mapped values flow through the lazy drive", async () => {
    const exp = await run(`
      function It(this: any): void {}
      (It as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf(([] as any)[Symbol.iterator]()));
      let count = 3;
      const iter: any = {
        next: function(): any {
          --count;
          return count >= 0 ? { done: false, value: count } : { done: true, value: undefined };
        },
      };
      const mapped: any = (It as any).prototype.map.call(iter, function(v: any): any { return v * 10; });
      let sum = 0;
      for (const e of mapped) sum = sum + e;
      return sum;
    `);
    expect(exp.test()).toBe(30);
  });

  // The accessor-next shape (`{ get next() {...} }`) — the real test262 files
  // use this; the record shim must defineProperty over the inherited
  // getter-only accessor rather than assign through it.
  it("map.call on a getter-next plain iterator (accessor shape) throws from the callback", async () => {
    const exp = await run(`
      function It(this: any): void {}
      (It as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf(([] as any)[Symbol.iterator]()));
      const iter: any = {
        get next() {
          let count = 3;
          return function(): any {
            --count;
            return count >= 0 ? { done: false, value: count } : { done: true, value: undefined };
          };
        },
      };
      const mapped: any = (It as any).prototype.map.call(iter, function(v: any): any { throw new Error('CB-RAN'); });
      let out = 'no-throw';
      try { for (const e of mapped); } catch (e: any) { out = e.message; }
      return out;
    `);
    expect(exp.test()).toBe("CB-RAN");
  });

  // Direct helper-method dispatch on an any-typed receiver (`iter.toArray()`)
  // — the second hook site (dispatchRecv) in __extern_method_call.
  it("toArray() called as a method on a plain compiled iterator materializes the values", async () => {
    const exp = await run(`
      function It(this: any): void {}
      (It as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf(([] as any)[Symbol.iterator]()));
      let count = 3;
      const iter: any = {
        next: function(): any {
          --count;
          return count >= 0 ? { done: false, value: count } : { done: true, value: undefined };
        },
      };
      const arr: any = (It as any).prototype.toArray.call(iter);
      return arr.length + ':' + arr[0] + arr[1] + arr[2];
    `);
    expect(exp.test()).toBe("3:210");
  });
});
