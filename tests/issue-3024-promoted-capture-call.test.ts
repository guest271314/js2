// (#3024) Calling a capturing nested function AFTER a method/accessor capture
// promotion produced invalid Wasm.
//
// Shape: a local is closure-MUTATED by a nested function (boxed into a ref
// cell, `fctx.boxedCaptures`), and an object-literal method also references
// it. Compiling the object literal runs the accessor/method capture promotion
// (#2029/#3039/#3121, closures.ts): the shared cell is aliased into a module
// global and the `localMap` binding is DELETED so post-promotion code routes
// through the global. But the direct-call capture-prepend in calls.ts checked
// `boxedCaptures` FIRST and resolved `localMap.get(name) ?? cap.outerLocalIdx`
// — the stale pre-boxing RAW slot — baking `local.get <f64>` where the callee
// expects the ref cell: `call[0] expected (ref null N), found local.get of
// type f64` (test262 language/expressions/object/dstr
// {meth,gen-meth,async-gen-meth}-ary-ptrn-(rest-ary-)elision, 6 files).
//
// The fix sources the SAME shared cell from the promotion global
// (`ctx.capturedBoxGlobals`) when the localMap binding is gone, so the callee
// mutation, the method body, and the enclosing function all share one cell.
//
// `WebAssembly.compile` is load-bearing: the regression was a *validation*
// failure. Runtime assertions prove the write-through semantics.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  const imports = buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#3024 capturing-fn call after method capture promotion", () => {
  it("nested fn mutating a var read by an object method — validates and writes through", async () => {
    expect(
      await run(`
        export function test(): number {
          var first = 0;
          function g2() { first += 1; }
          var obj = { method([,]) { if (first !== 1) return 0; } };
          g2();
          obj.method([1]);
          return first;
        }
      `),
    ).toBe(1);
  });

  it("generator arg + destructuring-param method (test262 elision shape) validates", async () => {
    expect(
      await run(`
        export function test(): number {
          var first = 0;
          function* g() { first += 1; yield; }
          var obj = { method([,]) { if (first !== 1) return 0; return 1; } };
          obj.method(g());
          return first;
        }
      `),
    ).toBe(1);
  });

  it("method with a NORMAL param — same promotion, same call path", async () => {
    expect(
      await run(`
        export function test(): number {
          var first = 0;
          function g2() { first += 2; }
          var obj = { method(x: number) { if (first !== 2) return 0; } };
          g2();
          obj.method(1);
          return first;
        }
      `),
    ).toBe(2);
  });

  it("method mutation is visible to the enclosing function after the callee ran (shared cell)", async () => {
    expect(
      await run(`
        export function test(): number {
          var first = 0;
          function g2() { first += 1; }
          var obj = { method([,]) { first = first + 10; } };
          g2();
          obj.method([1]);
          return first;
        }
      `),
    ).toBe(11);
  });

  it("control: capturing call with NO object-literal method stays correct", async () => {
    expect(
      await run(`
        export function test(): number {
          var first = 0;
          function g2() { first += 1; }
          g2();
          g2();
          return first;
        }
      `),
    ).toBe(2);
  });
});
