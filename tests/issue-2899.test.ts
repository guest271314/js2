import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

// #2899 — ≤ES3: Function `.caller` / `.arguments` poison-pill must throw
// TypeError on get AND set (`bound.caller`, `bound.caller = {}`, etc.).
//
// `Function.prototype.caller` / `Function.prototype.arguments` are poison-pill
// accessor properties whose `[[Get]]` and `[[Set]]` invoke %ThrowTypeError%
// (ES5 §13.2.3 / ES2015+ §9.2.7). A bound function inherits them from
// %FunctionPrototype%, so reading or writing `bound.caller` / `bound.arguments`
// must raise a catchable TypeError.
//
// The originally-failing test262 case
// (language/statements/function/13.2-30-s.js, assert #4 at L22) was
// `bound.caller = {}` silently no-op'ing instead of throwing. The fix landed
// via #2745's `_safeSet` strictAccessorWrite path: member-assignment routes
// through `__extern_set_strict`, which walks the prototype chain, finds the
// inherited poison-pill setter, lets the write run, and re-throws the setter's
// TypeError so the user's try/catch sees it. The get arms throw via the host
// `__extern_get` invoking the inherited poison-pill getter. This test locks
// the behaviour in so a future change to the member-set/get dispatch or the
// `_safeSet` strict path cannot silently regress it.

async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  // The bound-function bridge needs the live exports to dispatch the wasm
  // closure target (#1632a/#2745).
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return instance.exports as Record<string, Function>;
}

describe("#2899 — bound-function caller/arguments poison-pill throws on get and set", () => {
  it("get/set of bound.caller and bound.arguments all throw TypeError", async () => {
    // Mirrors the test262 wrapper shape (void `() => void` callbacks + a
    // module-level accumulator, exactly like the runner's synthesised
    // `assert_throws`). Each throwing arm contributes a distinct decimal digit
    // so a single return value pinpoints which arm failed to throw:
    //   1 = get bound.caller, 10 = set bound.caller (#2899's original gap),
    //   100 = get bound.arguments, 1000 = set bound.arguments.
    const e = await compileAndRun(`
      let __score: number = 0;
      function expectThrowsTE(bit: number, fn: () => void): void {
        try { fn(); } catch (err) { if (err instanceof TypeError) { __score = __score + bit; } return; }
      }
      export function test(): number {
        function target() {}
        var self = {};
        var bound = target.bind(self);
        expectThrowsTE(1,    function() { return bound.caller; });
        expectThrowsTE(10,   function() { bound.caller = {}; });
        expectThrowsTE(100,  function() { return bound.arguments; });
        expectThrowsTE(1000, function() { bound.arguments = {}; });
        return __score;
      }
    `);
    expect(e.test!()).toBe(1111);
  });

  it("bound functions have no own caller/arguments (inherited from %FunctionPrototype%)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        function target() {}
        var self = {};
        var bound = target.bind(self);
        var r = 0;
        if (bound.hasOwnProperty('caller') === false) r += 1;
        if (bound.hasOwnProperty('arguments') === false) r += 10;
        return r;
      }
    `);
    expect(e.test!()).toBe(11);
  });

  it("control: ordinary object & function-custom property set/get is unaffected", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var o: any = {}; o.x = 7;          // ordinary object property
        function f() {}
        (f as any).foo = 42;               // function's own non-poison property
        return o.x + (f as any).foo;       // 49
      }
    `);
    expect(e.test!()).toBe(49);
  });

  // Authoritative end-to-end guard: the exact test262 case, run through the
  // production runner. Skipped gracefully when the test262 submodule isn't
  // checked out (e.g. lightweight `quality` job) — the unit tests above still
  // guard the behaviour.
  it("test262 language/statements/function/13.2-30-s.js passes", async () => {
    const file = join(
      import.meta.dirname ?? ".",
      "..",
      "test262",
      "test",
      "language",
      "statements",
      "function",
      "13.2-30-s.js",
    );
    if (!existsSync(file)) {
      // submodule not present in this job — the unit tests cover the behaviour
      return;
    }
    const r = await runTest262File(file, "language");
    expect(r.status).toBe("pass");
  });
});
