import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2758 — Object/array-pattern default-init side effect + captured-var read on
// the "init-skipped" path (ES2015 §13.3.3.7 KeyedBindingInitialization).
//
// When a destructuring PARAMETER default references a nested closure that
// mutably captures an outer `var` (`counter` ↦ `initCount`), and the function
// ALSO reads that captured var, the call-site lazy-box machinery used to create
// the ref-cell box inside the conditionally-executed default `then`-arm. With
// the property PRESENT the default is skipped, the box was never created, and
// the later read dereferenced a null box → sNaN/NaN. Fix (#2758): the box is now
// materialized eagerly at the function top (companion to the #2692 declaring-
// scope eager-box pass), so the read sees the live by-value capture.
async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("#2758 — dstr default side effect / captured-var read on init-skipped", () => {
  it("present falsy props do NOT fire the default and the captured counter stays 0", async () => {
    // Mirrors test262 language/statements/function/dstr/obj-ptrn-id-init-skipped.js,
    // wrapped (as the runner does) so initCount/counter are captured locals.
    const e = await compileAndRun(`
      export function test(): number {
        var initCount = 0;
        function counter() { initCount += 1; }
        function f({ w = counter(), x = counter(), y = counter(), z = counter() }) {
          let code = 0;
          if (w === null) code += 1;
          if (x === 0) code += 2;
          if (y === false) code += 4;
          if (z === "") code += 8;
          code += initCount * 16;   // initCount must read 0 (not NaN)
          return code;
        }
        return f({ w: null, x: 0, y: false, z: "" });
      }
    `);
    // 1+2+4+8 = 15, with initCount*16 == 0 (present → no default fired).
    expect(e.test!()).toBe(15);
  });

  it("captured-var read returns the live value, never the sNaN sentinel", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var initCount = 0;
        function counter() { initCount += 1; }
        function f({ w = counter() }) { return initCount; }
        return f({ w: null });
      }
    `);
    expect(e.test!()).toBe(0);
  });

  it("when the property IS undefined the default still fires (initCount mutates within f)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var initCount = 0;
        function counter() { initCount += 1; }
        function f({ w = counter(), x = counter() }) { return initCount; }
        // both props undefined → both defaults fire → counter runs twice
        return f({});
      }
    `);
    expect(e.test!()).toBe(2);
  });
});
