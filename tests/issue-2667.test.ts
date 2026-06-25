import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";
import { buildImports } from "./equivalence/helpers.js";

// #2667 — ≤ES3 mapped-arguments non-configurable / non-writable property
// attributes + [[Delete]] semantics (ECMA-262 §10.4.4). Residual of #1511.
//
// These cases require *mapped* (sloppy-mode) arguments, where index properties
// stay linked to the formal parameters. The test262 harness compiles such
// `noStrict` script tests with `inferModuleStrictArguments: false` so the
// synthetic `export function test()` wrapper does not force module-strict (which
// would unmap arguments). We mirror that here — `compileToWasm` defaults to
// module-strict, which would make these functions strict/unmapped.
async function compileSloppyToWasm(source: string) {
  const result = await compile(source, { inferModuleStrictArguments: false });
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

describe("#2667 mapped arguments non-configurable / delete", () => {
  // mapped-arguments-nonconfigurable-delete-1.js
  it("delete on a non-configurable mapped index returns false, value unchanged", async () => {
    const exports = await compileSloppyToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { configurable: false });
        const r = delete arguments[0];
        return (r ? 1000 : 0) + (a as number) * 10 + (arguments[0] as number);
      }
      export function test(): any { return fn(1); }
    `);
    // r === false (0), a === 1, arguments[0] === 1  =>  0 + 10 + 1 = 11
    expect((exports as any).test()).toBe(11);
  });

  // mapped-arguments-nonconfigurable-delete-2.js (SetMutableBinding tail)
  it("failed delete leaves the mapping live (param write reflects)", async () => {
    const exports = await compileSloppyToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { configurable: false });
        const r = delete arguments[0];
        a = 2;
        return (r ? 1000 : 0) + (arguments[0] as number);
      }
      export function test(): any { return fn(1); }
    `);
    // r === false (0); mapping live so arguments[0] tracks a===2 => 2
    expect((exports as any).test()).toBe(2);
  });

  // mapped-arguments-nonconfigurable-delete-4.js (Set tail)
  it("failed delete leaves the mapping live (arguments write reflects)", async () => {
    const exports = await compileSloppyToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { configurable: false });
        const r = delete arguments[0];
        arguments[0] = 2;
        return (r ? 1000 : 0) + (a as number);
      }
      export function test(): any { return fn(1); }
    `);
    // r === false (0); mapping live so a tracks arguments[0]===2 => 2
    expect((exports as any).test()).toBe(2);
  });

  // mapped-arguments-nonconfigurable-3.js / -delete-3.js value-redefine tail
  it("redefining value of a non-configurable mapped index updates param + arguments", async () => {
    const exports = await compileSloppyToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { configurable: false });
        Object.defineProperty(arguments, "0", { value: 2 });
        return (a as number) * 10 + (arguments[0] as number);
      }
      export function test(): any { return fn(1); }
    `);
    // a === 2, arguments[0] === 2 => 22
    expect((exports as any).test()).toBe(22);
  });

  // mapped-arguments-nonwritable-nonconfigurable-3.js
  it("writable:false drops later arguments writes and severs the map", async () => {
    const exports = await compileSloppyToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { writable: false });
        arguments[0] = 2;            // ignored: non-writable
        Object.defineProperty(arguments, "0", { configurable: false });
        a = 3;                        // map severed by writable:false; no reflect
        return (a as number) * 10 + (arguments[0] as number);
      }
      export function test(): any { return fn(1); }
    `);
    // a === 3, arguments[0] === 1 => 31
    expect((exports as any).test()).toBe(31);
  });

  // mapped-arguments-nonconfigurable-nonwritable-5.js
  it("nonconfigurable then value-redefine then nonwritable severs map", async () => {
    const exports = await compileSloppyToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { configurable: false });
        Object.defineProperty(arguments, "0", { value: 2 });
        Object.defineProperty(arguments, "0", { writable: false });
        a = 3;                        // map severed by writable:false
        return (a as number) * 10 + (arguments[0] as number);
      }
      export function test(): any { return fn(1); }
    `);
    // a === 3, arguments[0] === 2 => 32
    expect((exports as any).test()).toBe(32);
  });

  // mapped-arguments-nonwritable-nonconfigurable-4.js — writable:false (still
  // configurable) then a value redefine to a DIFFERENT value is permitted
  // because the slot is still configurable; the map is already severed.
  it("value redefine after writable:false (still configurable) updates only arguments", async () => {
    const exports = await compileSloppyToWasm(`
      function fn(a: any): any {
        Object.defineProperty(arguments, "0", { writable: false });
        Object.defineProperty(arguments, "0", { value: 2 });
        Object.defineProperty(arguments, "0", { configurable: false });
        a = 3;                        // map severed; no reflect into arguments
        return (a as number) * 10 + (arguments[0] as number);
      }
      export function test(): any { return fn(1); }
    `);
    // a === 3, arguments[0] === 2 => 32
    expect((exports as any).test()).toBe(32);
  });

  // Regression guard: a plain mapped function still round-trips both directions.
  it("does not disturb the normal mapped link", async () => {
    const fwd = await compileSloppyToWasm(`
      function fn(a: any): any { a = 5; return arguments[0]; }
      export function test(): any { return fn(1); }
    `);
    expect((fwd as any).test()).toBe(5);
    const rev = await compileSloppyToWasm(`
      function fn(a: any): any { arguments[0] = 7; return a; }
      export function test(): any { return fn(1); }
    `);
    expect((rev as any).test()).toBe(7);
  });
});
