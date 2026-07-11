// (#3024) Increment/decrement on an element whose ARRAY REP is not the numeric
// working type produced invalid Wasm — two emitter bugs, default (JS-host) lane:
//
// 1. `compileMemberIncDec` vec arm (src/codegen/expressions/unary-updates.ts):
//    the read coerced elemType→f64, but the WRITE-BACK stored the raw f64
//    `newTmp` local with no f64→elemType coercion. On an externref-element
//    array (`arguments[i]++`, `any[]` increments) the emitted `array.set` got
//    `expected externref, found local.get of type f64` (test262
//    prefix/postfix-inc/dec `11.3.x/11.4.x-2-3(-s)` cluster, 4 files).
//    A non-fast i32 element additionally fed a raw i32 read into f64 arithmetic.
//
// 2. `buildElemCoerce` in `buildVecFromExternref` (src/codegen/type-coercion.ts)
//    had NO i64 arm: BigInt (i64) element arrays fell through to the empty
//    terminal case, leaving the externref element on the stack where the i64
//    `array.set` expects an i64 (`__vec_from_extern_*` invalid-Wasm cluster,
//    test262 prefix/postfix-inc/dec `bigint.js`, 4 files).
//
// `WebAssembly.compile` below is load-bearing: the bug class is a *validation*
// failure, so compile()-succeeds alone would not catch it. Runtime assertions
// confirm value semantics where the feature is fully supported.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileValid(source: string) {
  const r = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // The regression was invalid-Wasm emission — assert the binary VALIDATES.
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  return r;
}

async function run(source: string): Promise<unknown> {
  const r = await compileValid(source);
  const imports = buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#3024 inc/dec element write-back rep coercion (externref-element arrays)", () => {
  it("arguments[i]++ validates and increments in place (postfix)", async () => {
    expect(
      await run(`
        function testcase(): number { arguments[1] = 7; arguments[1]++; return arguments[1] as number; }
        export function test(): number { return testcase(); }
      `),
    ).toBe(8);
  });

  it("postfix on arguments element returns the OLD value", async () => {
    expect(
      await run(`
        function testcase(): number { arguments[1] = 7; return (arguments[1]++) as number; }
        export function test(): number { return testcase(); }
      `),
    ).toBe(7);
  });

  it("prefix decrement on arguments element returns the NEW value", async () => {
    expect(
      await run(`
        function testcase(): number { arguments[1] = 7; return (--arguments[1]) as number; }
        export function test(): number { return testcase(); }
      `),
    ).toBe(6);
  });

  it("any[] element postfix increment validates and writes back", async () => {
    expect(
      await run(`export function test(): number { var a: any[] = [7, 'x']; a[0]++; return a[0] as number; }`),
    ).toBe(8);
  });

  it("any[] element prefix increment returns the new value", async () => {
    expect(await run(`export function test(): number { var a: any[] = [7, 'x']; return (++a[0]) as number; }`)).toBe(8);
  });

  it("plain number[] element inc/dec is unchanged (control)", async () => {
    expect(await run(`export function test(): number { var a = [7]; a[0]++; --a[0]; a[0]++; return a[0]; }`)).toBe(8);
  });
});

describe("#3024 __vec_from_extern i64 (BigInt) element materialization", () => {
  // Full BigInt inc/dec SEMANTICS are gated on the i64-brand work (#1349/#1644);
  // this issue's acceptance criterion is that the module VALIDATES (it previously
  // failed Wasm validation inside __vec_from_extern_*).
  it("bigint-element array with element increment compiles to VALID Wasm", async () => {
    await compileValid(`
      export function test(): number {
        var x = [0n];
        x[0]++;
        return 1;
      }
    `);
  });

  it("bigint-element array with prefix decrement compiles to VALID Wasm", async () => {
    await compileValid(`
      export function test(): number {
        var x = [5n];
        --x[0];
        return 1;
      }
    `);
  });
});
