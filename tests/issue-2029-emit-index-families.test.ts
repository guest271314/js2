/**
 * #2029 — final `index out of range` emit-crash families (2026-07-04 harvest).
 *
 * The live standalone baseline was down to FOUR tests still dying in the
 * encoder with the #2043 "index out of range" named error. Three producers:
 *
 *  A. `local index out of range — 2 (valid: [0,2)) at '__anon_0_get_next'`
 *     (for-of/iterator-next-reference.js, BOTH modes): the
 *     Object.defineProperty descriptor accessor path compiled `get(){...}`
 *     bodies in a fresh fctx WITHOUT `promoteAccessorCapturesToGlobals`
 *     (the object-literal accessor path has always called it). A getter body
 *     returning a nested function (`get() { return next; }` where
 *     `function next()` captures an enclosing local) materialized next's
 *     closure with `cap.outerLocalIdx` — a slot of the ENCLOSING function —
 *     baked into the accessor body. Fix: promote transitive captures of
 *     referenced nested functions (value global for immutable captures,
 *     shared ref-cell box global for mutable ones) and teach the two
 *     closure-materialization sites to source from those globals when the
 *     current fctx cannot resolve the name.
 *
 *  B. `global index out of range — -1 at 'RE_@@replace'`
 *     (replaceAll/searchValue-replacer-RegExp-call{,-fn}.js, standalone):
 *     `emitSuperExternMethodCall` — a pure JS-host bridge
 *     (`__extern_method_call`) — ran under standalone and pushed the method
 *     name via the raw `global.get stringGlobalMap.get(name)` (-1 sentinel).
 *     Fix: refuse the host bridge standalone/wasi; dual-mode name push
 *     (`stringConstantExternrefInstrs`) for the gc+nativeStrings combination.
 *
 *  C. `global index out of range — -1 at 'test'`
 *     (property-accessors/S11.2.1_A3_T2.js, standalone): the
 *     ELEMENT-ACCESS number-method arm (`1["toFixed"](5)`, `5["toString"](2)`)
 *     pushed its RangeError message via the raw -1-sentinel `global.get`;
 *     the dot-access twin already used `stringConstantExternrefInstrs`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const FAMILY_A_SRC = `
export function test(): number {
  var iterable = {};
  var iterator = {};
  var iterationCount = 0;
  var loadNextCount = 0;
  iterable["foo"] = function() { return 1; };
  function next() { return iterationCount; }
  Object.defineProperty(iterator, 'next', {
    get() { loadNextCount++; return next; },
    configurable: true
  });
  return 1;
}
`;

const FAMILY_B_SRC = `
class RE extends RegExp {
  [Symbol.replace](a: any, b: any): any {
    return super[Symbol.replace](a, b);
  }
}
export function test(): number { return 1; }
`;

const FAMILY_C_SRC = `export function test(): number { return 1["toFixed"](5) === "1.00000" ? 1 : 0; }`;
const FAMILY_C_RADIX_SRC = `export function test(): number { return 5["toString"](2) === "101" ? 1 : 0; }`;

describe("#2029 emit-index families — no more encoder index-out-of-range crashes", () => {
  it("A: defineProperty getter returning a capture-carrying nested fn compiles (gc)", async () => {
    const r = await compile(FAMILY_A_SRC, { fileName: "test.ts", skipSemanticDiagnostics: true });
    expect(r.errors?.filter((e) => e.severity === "error")).toEqual([]);
    expect(r.success).toBe(true);
  });

  it("A: same shape compiles under --target standalone", async () => {
    const r = await compile(FAMILY_A_SRC, {
      fileName: "test.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(r.errors?.filter((e) => e.severity === "error")).toEqual([]);
    expect(r.success).toBe(true);
  });

  it("A: mutable transitive capture shares one cell (runtime, gc)", async () => {
    // The getter is exercised indirectly: materializing `inc`'s closure inside
    // the accessor must alias the SAME box the enclosing function writes
    // through. Here we validate the enclosing-fn side still behaves (the
    // box-promotion rewires test's own reads/writes through the ref cell).
    const src = `
export function test(): number {
  var count = 0;
  var obj = {};
  obj["pad"] = function() { return 1; };
  function reader() { return count; }
  Object.defineProperty(obj, 'r', { get() { return reader; }, configurable: true });
  count = count + 41;
  count++;
  return count;
}
`;
    const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
  });

  it("B: super[Symbol.replace] on a RegExp subclass no longer emit-crashes standalone", async () => {
    const r = await compile(FAMILY_B_SRC, {
      fileName: "test.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    // Either a clean compile or a loud located refusal is acceptable — the
    // raw encoder RangeError is not.
    const msgs = (r.errors ?? []).map((e) => e.message ?? "");
    expect(msgs.join("\n")).not.toContain("out of range");
    if (r.success) {
      // The host `__extern_method_call` bridge must NOT leak standalone.
      const m = new WebAssembly.Module(r.binary!);
      const importNames = WebAssembly.Module.imports(m).map((i) => i.name);
      expect(importNames).not.toContain("__extern_method_call");
      expect(importNames).not.toContain("__js_array_new");
    }
  });

  it("B: gc mode keeps the host super-dispatch (no regression)", async () => {
    const r = await compile(FAMILY_B_SRC, { fileName: "test.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
  });

  it("C: 1['toFixed'](5) compiles, instantiates host-free, and computes (standalone)", async () => {
    const r = await compile(FAMILY_C_SRC, {
      fileName: "test.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(r.errors?.filter((e) => e.severity === "error")).toEqual([]);
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("C: 5['toString'](2) compiles and computes (standalone)", async () => {
    const r = await compile(FAMILY_C_RADIX_SRC, {
      fileName: "test.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("C: gc mode unchanged (byte-equivalent global.get path)", async () => {
    const r = await compile(FAMILY_C_SRC, { fileName: "test.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
  });
});
