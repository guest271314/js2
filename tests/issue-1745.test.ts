import { describe, it, expect } from "vitest";

import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// #1745 — A function-scoped `var` declared inside a closure/arrow body that
// collides (by name) with a same-named MODULE GLOBAL of a different Wasm type
// used to fall through to the module global, because closures never ran the
// `var`-hoisting pre-pass that regular functions run (function-body.ts). The
// resolver then bound the closure's `var` to `global.get/set $__mod_<name>`,
// emitting a `global.set` (or `global.get` feeding a numeric op) whose value
// type did not match the global's declared type.
//
// In acorn this surfaced as `__closure_37` failing `WebAssembly.compile()`:
//   global.set[0] expected type f64, found if of type (ref null 3)
// — a top-level numeric `var i` (→ f64 module global) colliding with an
// array-holding `var i`/`var list` inside a closure (→ a vec struct ref).
//
// Fix: closures/arrows now run `hoistVarDeclarations` so a `var` in their body
// allocates a function-local that SHADOWS the module global (ECMA-262
// §10.2.10), exactly as regular functions do. The C-style for-loop init path
// also now honours that local shadow before reaching for the module global.

/** Compile `src` and assert the emitted binary passes `WebAssembly.compile`. */
async function compilesAndValidates(src: string): Promise<void> {
  const r = (await compile(src, { fileName: "t.mjs" })) as {
    success: boolean;
    binary: Uint8Array;
    errors?: { message: string }[];
  };
  expect(r.success, r.errors?.[0]?.message ?? "compile failed").toBe(true);
  // The whole point of the bug: compile() reported success but the binary was
  // structurally invalid. WebAssembly.compile must now accept it.
  await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
}

describe("#1745 — closure var shadows a differently-typed module global", () => {
  it("for-init `var i`/`var list` in a closure shadow a top-level numeric module global", async () => {
    // Top-level numeric for-loop hoists module globals `i` (f64) and `list`.
    // The closure's own `for (var i = 0, list2 = arr; ...)` must bind to its
    // own locals, not the f64 module global `i`.
    await compilesAndValidates(`
      for (var i = 0, list = [9, 10, 11]; i < list.length; i += 1) { var v = list[i]; }
      var f = function (arr) {
        for (var i = 0, list2 = arr; i < list2.length; i += 1) {
          var w = list2[i];
        }
        return i;
      };
      export function test() { return f([1, 2, 3]); }
    `);
  });

  it("a nested closure `var i` holding an array shadows the numeric module global `i`", async () => {
    await compilesAndValidates(`
      for (var i = 0, list = [9, 10, 11]; i < list.length; i += 1) { var v = list[i]; }
      var f = function (arr) {
        var build = function (extra) {
          var i = arr.slice();   // function-scoped i holds an array, not a number
          i.push(extra);
          return i.length;
        };
        return build(arr.length);
      };
      export function test() { return f([1, 2, 3]); }
    `);
  });

  it("runtime: shadowed closure var does not clobber the module global", async () => {
    const src = `
      var i = 0;
      for (i = 0; i < 3; i += 1) {}        // i ends at 3 (module global, f64)
      var f = function (arr) {
        var i = arr.slice();               // closure-local i (array) — must shadow
        return i.length;                   // 2, from the local array
      };
      export function test() {
        var localLen = f([7, 8]);          // 2
        return localLen * 100 + i;         // 2*100 + 3 = 203 if i was not clobbered
      }
    `;
    const exports = (await compileAndInstantiate(src)) as { test?: () => number };
    expect(exports.test?.()).toBe(203);
  });
});
