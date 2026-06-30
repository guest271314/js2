import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";
import { buildImports } from "./equivalence/helpers.js";

// #2897 — ≤ES3: `arguments` as a SimpleAssignmentTarget crashed (null-deref).
//
// test262: language/expressions/assignmenttargettype/simple-basic-identifierreference-arguments.js
//   → `arguments = 1;` (flags: [noStrict])
//
// In non-strict code `arguments` is a valid SimpleAssignmentTarget (§13.15.1),
// so `arguments = X` rebinds the identifier to X. `arguments` is materialized as
// a concrete (non-null) vec ref local; coercing an arbitrary RHS to that vec-ref
// type previously emitted a trapping `ref.as_non_null (ref.null …)` — the
// "dereferencing a null pointer" crash. The fix rebinds `arguments` to a fresh
// externref local holding X and severs the param↔arguments map.
//
// These are `noStrict` cases — the test262 harness compiles such script tests
// with `inferModuleStrictArguments: false` so the synthetic `export function
// test()` wrapper does not force module-strict (which would unmap `arguments`
// and reject the assignment as a strict-mode violation). We mirror that here.
async function compileSloppyToWasm(source: string) {
  // Mirror the test262 runner (tests/test262-runner.ts): script tests compile
  // with `inferModuleStrictArguments: false` (sloppy/mapped arguments) and
  // `skipSemanticDiagnostics: true` (TS would otherwise reject `arguments = X`
  // as a strict-mode violation / `number`-not-assignable-to-`IArguments`).
  const result = await compile(source, {
    inferModuleStrictArguments: false,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const manualImports = buildImports(result);
  let setExportsFn: ((exports: Record<string, Function>) => void) | undefined;
  if (result.imports && result.imports.length > 0) {
    const runtimeResult = buildRuntimeImports(result.imports, undefined, result.stringPool);
    setExportsFn = runtimeResult.setExports;
    manualImports.env = { ...(manualImports.env as Record<string, Function>), ...runtimeResult.env };
    if (runtimeResult.string_constants) manualImports.string_constants = runtimeResult.string_constants;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, manualImports);
  if (setExportsFn) setExportsFn(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#2897 arguments as assignment target", () => {
  // The exact test262 shape: `arguments = 1;` must compile + run (no crash).
  it("`arguments = 1` runs without a null-deref crash", async () => {
    const exports = await compileSloppyToWasm(`
      export function test(): number {
        arguments = 1;
        return 1;
      }
    `);
    expect((exports as any).test()).toBe(1);
  });

  // The assignment expression evaluates to the RHS value.
  it("`arguments = X` evaluates to X", async () => {
    const exports = await compileSloppyToWasm(`
      export function test(): number {
        const r: any = (arguments = 7);
        return r as number;
      }
    `);
    expect((exports as any).test()).toBe(7);
  });

  // Reassignment rebinds the identifier: a subsequent read of `arguments`
  // returns the rebound value, not the original arguments object.
  it("`arguments = X; return arguments` returns X", async () => {
    const exports = await compileSloppyToWasm(`
      export function test(): number {
        arguments = 42;
        return arguments as number;
      }
    `);
    expect((exports as any).test()).toBe(42);
  });

  // A non-number RHS (string) also rebinds without trapping.
  it('`arguments = "str"` rebinds to the string', async () => {
    const exports = await compileSloppyToWasm(`
      export function fn(): any {
        arguments = "hello";
        return arguments;
      }
      export function test(): number {
        return (fn() === "hello") ? 1 : 0;
      }
    `);
    expect((exports as any).test()).toBe(1);
  });

  // Reassigning `arguments` severs the param↔arguments map: the formal
  // parameter keeps its passed value, unaffected by the rebind.
  it("reassigning `arguments` leaves the formal parameter intact", async () => {
    const exports = await compileSloppyToWasm(`
      export function fn(a: number): number {
        arguments = 99;
        return a;
      }
      export function test(): number {
        return fn(5);
      }
    `);
    expect((exports as any).test()).toBe(5);
  });

  // Regression control: mapped arguments still sync param ↔ arguments[i] when
  // `arguments` is NOT reassigned.
  it("mapped arguments[i] write still reflects into the param (no regression)", async () => {
    const exports = await compileSloppyToWasm(`
      export function fn(a: number): number {
        arguments[0] = 5;
        return a;
      }
      export function test(): number {
        return fn(1);
      }
    `);
    expect((exports as any).test()).toBe(5);
  });
});
