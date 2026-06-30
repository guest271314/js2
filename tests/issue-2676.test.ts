import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #2676 — ≤ES3 mapped `arguments`: a strict-mode **aliased** `delete args[i]`
// on a non-configurable index must throw TypeError (residual of #2667).
//
// Shape of the 4 failing test262 cases
// (language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-{1..4}.js):
//
//   function f(a) {
//     Object.defineProperty(arguments, "0", { configurable: false });
//     var args = arguments;                                    // (1) alias
//     assert.throws(TypeError, function() {                    // (3) nested fn
//       "use strict";                                          // (2) strict
//       delete args[0];                                        //     must THROW
//     });
//     assert.sameValue(a, 1);
//     assert.sameValue(arguments[0], 1);
//   }
//
// Three obstacles over the #2667 direct `delete arguments[i]` path:
//   1. the receiver is the alias `args`, not the literal `arguments`;
//   2. the delete lives in a nested *strict* closure that captures `args` and
//      has no `mappedArgsInfo` of its own;
//   3. the throw is conditional on the index being non-configurable.
//
// Fix: record each mapped function's live `mappedArgsInfo` keyed by its decl
// node (`ctx.mappedArgsInfoByFunc`); at the delete site resolve `args` →
// `var args = arguments` → owning function → its `nonConfigurableIndices`. A
// non-configurable index makes OrdinaryDelete fail (`false`); routing that
// `false` through the existing strict-delete check makes a strict caller throw
// TypeError (§13.5.1.2 step 6.b) while a sloppy caller observes `false`.

async function run(code: string): Promise<unknown> {
  const result = await compile(code, { fileName: "test.ts" });
  if (!result.success) throw new Error(`CE: ${result.errors[0]?.message}`);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as { main(): unknown }).main();
}

describe("#2676 — mapped arguments: strict aliased delete of a non-configurable index throws", () => {
  it("strict aliased `delete args[0]` throws TypeError; value + mapping intact", async () => {
    // Mirrors mapped-arguments-nonconfigurable-strict-delete-1.js. Returns the
    // throw flag (1) only when the inner strict delete threw AND `a` /
    // `arguments[0]` are untouched.
    const r = await run(`
      function throws(fn: () => void): number { try { fn(); return 0; } catch (e) { return 1; } }
      function f(a: any): number {
        Object.defineProperty(arguments, "0", { configurable: false });
        var args: any = arguments;
        var t: number = throws(function (): void { "use strict"; delete args[0]; });
        if (a !== 1) return 10;            // param untouched
        if (arguments[0] !== 1) return 11; // mapping/value untouched
        return t;                          // 1 = inner delete threw
      }
      export function main(): f64 { return f(1); }
    `);
    expect(r).toBe(1);
  });

  it("throws with the closure passed inline as a call argument (assert.throws shape)", async () => {
    // The real tests pass the strict callback DIRECTLY as a call argument
    // (`assert.throws(TypeError, function(){...})`), not via an intermediate
    // local — exercise that exact shape so the alias resolves through a
    // function-expression argument, and confirm the slot value is preserved.
    const r = await run(`
      function expectThrow(fn: () => void): number { try { fn(); return 0; } catch (e) { return 1; } }
      function f(a: any): number {
        Object.defineProperty(arguments, "0", { configurable: false });
        var args: any = arguments;
        if (expectThrow(function (): void { "use strict"; delete args[0]; }) !== 1) return 20;
        if (arguments[0] !== 1) return 21; // value/mapping untouched by failed delete
        return 1;
      }
      export function main(): f64 { return f(1); }
    `);
    expect(r).toBe(1);
  });

  it("CONTROL: sloppy aliased delete of a non-configurable index returns false, no throw, value intact", async () => {
    const r = await run(`
      function f(a: any): number {
        Object.defineProperty(arguments, "0", { configurable: false });
        var args: any = arguments;
        if (delete args[0]) return 2;       // sloppy delete must be falsy
        if (a !== 1) return 3;
        if (arguments[0] !== 1) return 4;   // value intact
        return 1;
      }
      export function main(): f64 { return f(1); }
    `);
    expect(r).toBe(1);
  });

  it("CONTROL: strict aliased delete of a CONFIGURABLE mapped index does NOT throw", async () => {
    // Index 0 left at its default (configurable). The non-configurable arm must
    // NOT fire, so the strict delete succeeds without a spurious TypeError.
    const r = await run(`
      function throws(fn: () => void): number { try { fn(); return 0; } catch (e) { return 1; } }
      function f(a: any): number {
        var args: any = arguments;
        return throws(function (): void { "use strict"; delete args[0]; });
      }
      export function main(): f64 { return f(1); }
    `);
    expect(r).toBe(0); // 0 = did not throw
  });

  it("CONTROL: regular-object strict delete of a non-configurable property still throws", async () => {
    // Guards the shared strict-delete path (must be untouched by the alias arm).
    const r = await run(`
      function g(): number {
        "use strict";
        var o: any = {};
        Object.defineProperty(o, "x", { value: 1, configurable: false });
        delete o.x; // strict + non-configurable → TypeError
        return 0;
      }
      export function main(): f64 { try { g(); return 0; } catch (e) { return 1; } }
    `);
    expect(r).toBe(1);
  });
});
