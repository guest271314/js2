/**
 * #3139 — Array generics over fnctor-instance array-likes (host lane).
 *
 * Two stacked fixes:
 *  1. `tryExternClassMethodOnAny` refuses the first-match extern bind for the
 *     Array iteration/search generics (every/filter/map/reduce/reduceRight/
 *     indexOf/lastIndexOf — extends #3014's forEach/some), so an `any`-typed
 *     fnctor array-like is no longer hijacked by `Uint8ClampedArray_every`.
 *  2. `__extern_length` / `__extern_get_idx` / `__extern_has_idx` resolve
 *     through the #3138 fnctor instance→ctor prototype chain after own-level
 *     misses, so the generic array loops see the Array-valued prototype's
 *     live length/elements.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    new Uint8Array(result.binary),
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  const ex: any = instance.exports;
  if (imports.setExports) imports.setExports(ex);
  const mi = ex.__module_init;
  if (typeof mi === "function") mi();
  return ex.test();
}

describe("#3139 — Array generics over fnctor-instance array-likes", () => {
  it("direct f.every(cb) iterates the inherited Array prototype elements", async () => {
    const src = `
export function test(): number {
  try {
    function foo() {}
    foo.prototype = new Array(11, 22, 33);
    var f: any = new foo();
    var seen = 0;
    var vals = 0;
    var r = f.every(function(val: any) { seen = seen + 1; vals = vals + val; return true; });
    return seen * 1000 + vals; // 3 iterations over 11+22+33 -> 3066
  } catch (e) { return -1; }
}
`;
    await expect(run(src)).resolves.toBe(3066);
  });

  it("Array.prototype.every.call(f, cb) sees inherited length and elements", async () => {
    const src = `
export function test(): number {
  try {
    function foo() {}
    foo.prototype = new Array(11, 22, 33);
    var f: any = new foo();
    var seen = 0;
    Array.prototype.every.call(f, function(val: any) { seen = seen + 1; return true; });
    return seen; // 3
  } catch (e) { return -1; }
}
`;
    await expect(run(src)).resolves.toBe(3);
  });

  it("own length shadows the inherited one (15.4.4.16-8-10 shape)", async () => {
    const src = `
export function test(): number {
  try {
    foo.prototype = new Array(1, 2, 3);
    function foo() {}
    var f: any = new foo();
    f.length = 2;
    var i = f.every(function(val: any) { return val <= 2; });
    return i === true ? 1 : 2;
  } catch (e) { return -1; }
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("any-receiver String/Array controls keep their regular paths", async () => {
    const src = `
export function test(): number {
  var s: any = "hello";
  if (s.indexOf("ll") !== 2) return 1;
  var a: any = [1, 2, 3];
  var m = a.map(function(x: any) { return x * 2; });
  if (m[2] !== 6) return 2;
  var r = a.reduce(function(acc: any, x: any) { return acc + x; }, 0);
  if (r !== 6) return 3;
  if (!a.every(function(x: any) { return x > 0; })) return 4;
  if (a.filter(function(x: any) { return x > 1; }).length !== 2) return 5;
  if (a.lastIndexOf(2) !== 1) return 6;
  return 100;
}
`;
    await expect(run(src)).resolves.toBe(100);
  });

  it("plain struct receivers without a ctor link are untouched (no spurious inherited reads)", async () => {
    const src = `
export function test(): number {
  try {
    var o: any = {};
    // no fnctor link, no length — the generic loop must see length 0
    var seen = 0;
    Array.prototype.forEach.call(o, function() { seen = seen + 1; });
    return seen; // 0
  } catch (e) { return -1; }
}
`;
    await expect(run(src)).resolves.toBe(0);
  });
});
