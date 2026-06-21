// #2582 — a non-literal NUMERIC key read on a statically-typed numeric-keyed
// object literal returned `undefined` when executed in MODULE-INIT (top-level)
// code, while the same read worked with a literal key or inside a function.
//
// Root cause: `obj[runtimeKey]` on a struct whose fields are numeric-named
// (`{ 9: …, 10: … }`) lowered to the DYNAMIC `__extern_get` host path (only a
// literal/const key resolved to a static `struct.get`). `__extern_get` →
// `_safeGet` reads the field via the `__sget_<key>` EXPORT, but the module-init
// top-level `for (…) f(list[i])` loop runs inside the Wasm START function,
// BEFORE `__setExports` wires the exports — so `__sget_9` is unavailable and
// the read returns undefined (then `_safeGet`'s well-known-symbol-ID branch,
// key 9 ∈ [1,15], swallowed it). acorn's
// `wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion])` in module-init
// `buildUnicodeData` hit exactly this → `wordsRegexp(undefined)` →
// `undefined.replace` → instantiation threw (#1712 acorn dogfood, 3rd blocker).
//
// Fix: a non-literal numeric key on a struct whose fields are ALL numeric-named
// externref slots emits a static `struct.get` key-switch (exports-independent),
// generalising the literal-key path to a runtime key.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2582 — numeric-key struct read with a runtime key at module-init", () => {
  it("reads numeric-keyed object via a runtime (array-sourced) key at TOP LEVEL", async () => {
    // The exact failing shape: top-level `props[arr[0]]` and `props[k]` where
    // `k = arr[0]`. Before the fix these returned undefined; the literal
    // `props[9]` always worked.
    const exp = await run(`
      // @ts-nocheck
      var props = { 9: "a", 10: "b" };
      var arr = [9, 10];
      var tlPlain = props[9];          // literal — always worked
      var tlArr = props[arr[0]];       // runtime key — was undefined
      var k = arr[0];
      var tlVar = props[k];            // runtime var key — was undefined
      export function probe() {
        return (tlPlain === "a" ? 1 : 0) + (tlArr === "a" ? 1 : 0) + (tlVar === "a" ? 1 : 0);
      }
    `);
    expect(exp.probe()).toBe(3);
  });

  it("module-level for-loop driving a numeric-key read does not throw (acorn shape)", async () => {
    // Mirrors acorn's `for (…) buildUnicodeData(list[i])` →
    // `wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion])`. The empty-
    // string values are the ones that previously read undefined and made
    // `.replace` throw on a null/undefined receiver during instantiation.
    const exp = await run(`
      // @ts-nocheck
      var regexpCache = {};
      function wordsRegexp(words) {
        return regexpCache[words] || (regexpCache[words] = new RegExp("^(?:" + words.replace(/ /g, "|") + ")$"));
      }
      var ecma14 = "Basic_Emoji RGI_Emoji";
      var props = { 9: "", 10: "", 11: "", 12: "", 13: "", 14: ecma14 };
      var count = 0;
      function build(ecmaVersion) { var r = wordsRegexp(props[ecmaVersion]); if (r) { count = count + 1; } }
      // MODULE-LEVEL loop — runs in the start function, before __setExports.
      for (var i = 0, list = [9, 10, 11, 12, 13, 14]; i < list.length; i += 1) {
        build(list[i]);
      }
      export function probe() { return count; }
    `);
    // 6 builds, none threw. (If module-init threw, instantiation would reject
    // and run() would fail before returning.)
    expect(exp.probe()).toBe(6);
  });

  it("a string-typed key still resolves the correct numeric field name", async () => {
    // The fix must NOT hijack a genuine string-keyed read. `props["9"]` (string)
    // names field "9" and must read "a" via the existing field-name path.
    const exp = await run(`
      // @ts-nocheck
      var props = { 9: "a", 10: "b" };
      export function probe() {
        var sk = "9";
        return props[sk] === "a" ? 1 : 0;
      }
    `);
    expect(exp.probe()).toBe(1);
  });
});
