import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3038 — for-await/async-gen iterator-close side-effect invisible.
// Two closure-capture bugs (NOT async-CPS versioning):
//   Bug #1 (FIXED here): a nested FUNCTION DECLARATION that only READS a
//     variable mutated by a SIBLING closure captured it by-value (stale
//     snapshot) instead of by-ref. Fix in nested-declarations.ts mirrors the
//     arrow path's `writtenInOuter` rule.
//   Bug #2 (#3039, FABLE-RESERVED): object-literal method shorthand / class
//     method / class accessor writing a BOXED transitively-captured var emits
//     garbage. The `*ary-init-iter-close` method-shorthand cluster needs #3039.
async function run(source: string): Promise<number> {
  const result = await compile(source, { skipSemanticDiagnostics: true } as any);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  const setExports = (imports as { setExports?: (e: unknown) => void }).setExports;
  if (typeof setExports === "function") setExports(instance.exports);
  return (instance.exports as Record<string, () => number>).test!();
}

describe("#3038 bug #1 — nested-fn-decl reader of a sibling-mutated captured var (FIXED)", () => {
  it("two sibling fn-decls sharing a mutable captured let: writer runs, reader sees it", async () => {
    // Minimal reduction of the iterator-close shape: h writes c, g reads it in
    // a separate top-level call. Read must observe the write (was: stale 0).
    const ret = await run(`export function test(): number {
      let c = 0;
      function h(): void { c = c + 1; }
      function g(): number { return c; }
      h();
      return g();
    }`);
    expect(ret).toBe(1);
  });

  it("nested reader fn observes a sibling closure's write via a shared var", async () => {
    const ret = await run(`export function test(): number {
      let c = 0;
      let obs = -1;
      function h(): void { c = c + 5; }
      function g(): void { h(); obs = c; }
      g();
      return obs === 5 ? 1 : 300 + obs;
    }`);
    expect(ret).toBe(1);
  });

  // Skipped in the STANDALONE #3038 landing: this integration scenario needs
  // #2664 (#3023)'s runtime `_walkWasmIterator` diversion for the JS-host
  // iterator-close (`return()`) to actually FIRE for a WasmGC-struct iterator.
  // Without #2664 on main the close is a no-op, so `obs` stays -1 (the body
  // never observes a close to read). Bug #1's fix (nested-fn reader-by-ref) is
  // validated standalone by the two sibling-capture cases above; this case
  // re-enables (→ `it`) once #2664 lands. (#3038 / #2664)
  it.skip("iterator-close (fn-expr-property return) observed by a nested-fn reader body", async () => {
    // fn-expr-property writer routes through the box-aware closure path; with
    // bug #1's reader-by-ref fix a nested reader fn observes the close. Sync
    // for-of so the assertion is self-contained (no microtask drain needed).
    const ret = await run(`export function test(): number {
      let doneCallCount = 0;
      let obs = -1;
      const iter: any = {};
      iter[Symbol.iterator] = function () {
        return {
          next: function () { return { value: 7, done: false }; },
          return: function () { doneCallCount = doneCallCount + 1; return {}; },
        };
      };
      function fn(): void {
        for (const [x] of [iter]) { obs = doneCallCount; }
      }
      fn();
      return obs === 1 ? 1 : 300 + obs;
    }`);
    expect(ret).toBe(1);
  });
});

describe.todo("#3038 bug #2 — method-shorthand/class boxed transitive capture write (#3039, FABLE-RESERVED)", () => {
  it("transitive object-literal METHOD write reaches the boxed captured var", async () => {
    const ret = await run(`export function test(): number {
      let c = 0;
      const make = function () { return { bump() { c += 1; } }; };
      const o = make(); o.bump(); o.bump();
      return c;
    }`);
    expect(ret).toBe(2);
  });
});
